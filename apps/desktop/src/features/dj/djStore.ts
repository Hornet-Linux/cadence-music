import { create } from "zustand";
import { usePlayer } from "@/player/playerStore";
import { planDjSet } from "./dj";
import type { DjTrack } from "./resolve";
import { currentOption, providerStatus, useProviders } from "./providers";
import { djSetup, setupMessage } from "./setup";
import { speakIntro, stopSpeaking } from "./voice";
import {
  chooseDjSource,
  connectSourceMessage,
  loadSourcePref,
  saveSourcePref,
  type DjMusicSource,
  type DjSourceId,
  type DjSourcePref,
} from "./sources";
import type { TasteProfile } from "./tasteProfile";

const VOICE_KEY = "dj:voice";
/** Fetch the next set when this many DJ tracks are left in the queue. */
const REFILL_AT = 2;

type Status = "idle" | "thinking" | "on";

interface DjState {
  status: Status;
  error: string | null;
  /** Set when the error is fixed in Settings (Ollama or the model is missing). */
  needsSetup: boolean;
  mood: string;
  /** Every track the DJ queued this session, in order. */
  history: DjTrack[];
  /** Spoken intro per track id. */
  intros: Record<string, string>;
  /** Speak intros between tracks. */
  voice: boolean;
  /** Which music source the person chose in Settings. */
  sourcePref: DjSourcePref;
  /** The source the running DJ plays from. */
  source: DjSourceId | null;

  setMood: (mood: string) => void;
  setSourcePref: (pref: DjSourcePref) => void;
  setVoice: (on: boolean) => void;
  start: () => Promise<void>;
  switchUp: () => Promise<void>;
  /** Append the next set when the DJ queue runs low. */
  refill: () => Promise<void>;
  stop: () => void;
}

function loadVoice(): boolean {
  try {
    return localStorage.getItem(VOICE_KEY) !== "0";
  } catch {
    return true;
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useDj = create<DjState>((set, get) => {
  let profile: TasteProfile | null = null;
  /** The music source this session plays from; fixed when the DJ starts. */
  let source: DjMusicSource | null = null;
  /** Bumped by stop/start so a slow reply from an old session is ignored. */
  let session = 0;

  async function getProfile(): Promise<TasteProfile> {
    if (profile) return profile;
    if (!source) throw new Error(connectSourceMessage(get().sourcePref));
    profile = await source.taste();
    return profile;
  }

  async function fetchSet(switchUp = false): Promise<DjTrack[] | null> {
    const id = session;
    const { mood, history } = get();
    const option = currentOption();
    if (!option) throw new Error("Add an AI provider in Settings → AI DJ first.");
    const next = await planDjSet(
      option.ref,
      await getProfile(),
      { mood: mood.trim() || undefined, switchUp, history },
      source ?? undefined,
    );
    if (id !== session) return null; // stopped or restarted meanwhile
    set((s) => ({
      history: [...s.history, ...next],
      intros: { ...s.intros, ...Object.fromEntries(next.map((d) => [d.track.id, d.intro])) },
    }));
    return next;
  }

  /** Run `work` with the thinking state, keeping the DJ on afterwards unless it failed. */
  async function think(work: () => Promise<void>) {
    const id = session;
    set({ status: "thinking", error: null });
    try {
      await work();
      if (id === session) set({ status: "on" });
    } catch (e) {
      if (id !== session) return;
      // A failed refill keeps the music going; a failed start turns the DJ off.
      set({ status: get().history.length ? "on" : "idle", error: message(e) });
    }
  }

  return {
    status: "idle",
    error: null,
    needsSetup: false,
    mood: "",
    history: [],
    intros: {},
    voice: loadVoice(),
    sourcePref: loadSourcePref(),
    source: null,

    setMood: (mood) => set({ mood }),
    setSourcePref(sourcePref) {
      set({ sourcePref });
      saveSourcePref(sourcePref);
    },
    setVoice(voice) {
      set({ voice });
      if (!voice) stopSpeaking();
      try {
        localStorage.setItem(VOICE_KEY, voice ? "1" : "0");
      } catch {
        // Storage is optional.
      }
    },

    async start() {
      const chosen = chooseDjSource(get().sourcePref);
      if (!chosen) {
        set({ error: connectSourceMessage(get().sourcePref) });
        return;
      }
      await useProviders.getState().refreshRemote();
      const option = currentOption();
      if (!option) {
        set({
          status: "idle",
          error: "This server has no AI DJ set up yet. Ask the server owner to turn it on (or add a provider in Settings → AI DJ).",
          needsSetup: true,
        });
        return;
      }
      // A provider on this device is checked through the app's bridge, which a test build may lack.
      if (option.scope !== "local" || window.host?.llm) {
        const status = await providerStatus(option.ref).catch((e) => ({ available: false, models: [], error: message(e) }));
        const msg = setupMessage(djSetup(option, status));
        if (msg) {
          set({ status: "idle", error: msg, needsSetup: true });
          return;
        }
      }
      session++;
      profile = null;
      source = chosen;
      set({ history: [], intros: {}, needsSetup: false, source: chosen.id });
      await think(async () => {
        const first = await fetchSet();
        if (first) await usePlayer.getState().playQueue(first.map((d) => d.track), 0);
      });
    },

    async switchUp() {
      if (get().status !== "on") return;
      await think(async () => {
        const next = await fetchSet(true);
        if (!next) return;
        // Keep what's playing, replace everything after it, then skip to the new set.
        const { queue, index } = usePlayer.getState();
        usePlayer.setState({ queue: [...queue.slice(0, index + 1), ...next.map((d) => d.track)] });
        await usePlayer.getState().next();
      });
    },

    async refill() {
      if (get().status !== "on") return;
      await think(async () => {
        const next = await fetchSet();
        if (next) usePlayer.setState((p) => ({ queue: [...p.queue, ...next.map((d) => d.track)] }));
      });
    },

    stop() {
      session++;
      stopSpeaking();
      set({ status: "idle", error: null, needsSetup: false, source: null });
    },
  };
});

// Introduce each new DJ track, top up the queue, and turn the DJ off when the
// user plays something else.
let lastIntroduced: string | null = null;
usePlayer.subscribe((p) => {
  const dj = useDj.getState();
  if (dj.status === "idle") {
    lastIntroduced = null;
    return;
  }
  const id = p.current?.id ?? null;
  if (id && id !== lastIntroduced && dj.intros[id]) {
    lastIntroduced = id;
    if (dj.voice) speakIntro(dj.intros[id]);
  }
  if (dj.status !== "on") return;
  if (p.current && !dj.intros[p.current.id]) return dj.stop();
  if (p.queue.length - 1 - p.index <= REFILL_AT) void dj.refill();
});
