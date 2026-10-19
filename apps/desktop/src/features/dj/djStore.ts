import { create } from "zustand";
import { DEFAULT_LLM_CONFIG, type LlmConfig } from "../../../electron/llm";
import { usePlayer } from "@/player/playerStore";
import { useSpotify } from "@/plugins/builtins/spotify/spotifyStore";
import { planDjSet } from "./dj";
import type { DjTrack } from "./resolve";
import { buildTasteProfile, isEmptyProfile, type TasteProfile } from "./tasteProfile";

const CONFIG_KEY = "dj:llm";
/** Fetch the next set when this many DJ tracks are left in the queue. */
const REFILL_AT = 2;

type Status = "idle" | "thinking" | "on";

interface DjState {
  status: Status;
  error: string | null;
  mood: string;
  config: LlmConfig;
  /** Every track the DJ queued this session, in order. */
  history: DjTrack[];
  /** Spoken intro per track id, for step 4. */
  intros: Record<string, string>;

  setMood: (mood: string) => void;
  setConfig: (config: LlmConfig) => void;
  start: () => Promise<void>;
  switchUp: () => Promise<void>;
  /** Append the next set when the DJ queue runs low. */
  refill: () => Promise<void>;
  stop: () => void;
}

function loadConfig(): LlmConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return { ...DEFAULT_LLM_CONFIG, ...(JSON.parse(raw) as Partial<LlmConfig>) };
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_LLM_CONFIG;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useDj = create<DjState>((set, get) => {
  let profile: TasteProfile | null = null;
  /** Bumped by stop/start so a slow reply from an old session is ignored. */
  let session = 0;

  async function getProfile(): Promise<TasteProfile> {
    if (profile) return profile;
    const p = await buildTasteProfile(useSpotify.getState().tracks);
    if (isEmptyProfile(p)) throw new Error("Play or like a few songs on Spotify first so the DJ knows your taste.");
    profile = p;
    return p;
  }

  async function fetchSet(switchUp = false): Promise<DjTrack[] | null> {
    const id = session;
    const { config, mood, history } = get();
    const next = await planDjSet(config, await getProfile(), { mood: mood.trim() || undefined, switchUp, history });
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
    mood: "",
    config: loadConfig(),
    history: [],
    intros: {},

    setMood: (mood) => set({ mood }),
    setConfig(config) {
      set({ config });
      try {
        localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
      } catch {
        // Storage is optional.
      }
    },

    async start() {
      if (useSpotify.getState().status !== "signed-in") {
        set({ error: "Connect Spotify to use the DJ." });
        return;
      }
      session++;
      profile = null;
      set({ history: [], intros: {} });
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
      set({ status: "idle", error: null });
    },
  };
});

// Top up the DJ queue, and turn the DJ off when the user plays something else.
usePlayer.subscribe((p) => {
  const dj = useDj.getState();
  if (dj.status !== "on") return;
  if (p.current && !dj.intros[p.current.id]) return dj.stop();
  if (p.queue.length - 1 - p.index <= REFILL_AT) void dj.refill();
});
