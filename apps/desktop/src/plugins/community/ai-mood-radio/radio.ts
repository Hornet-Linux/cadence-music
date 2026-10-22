import { create } from "zustand";
import type { DjSetOptions } from "@/features/dj/dj";
import type { DjTrack } from "@/features/dj/resolve";
import type { TasteProfile } from "@/features/dj/tasteProfile";
import type { Track } from "@/shared/types";
import type { PlaybackEvent } from "../../types";
import { feedbackNotes, ListenTracker, moodPrompt, shouldSwitchUp, upcoming, type MoodId, type Reaction } from "./mood";

/** Fetch the next set when this many radio tracks are left. */
export const REFILL_AT = 2;
const SET_SIZE = 8;

/** What the radio needs from the player. */
export interface PlayerPort {
  snapshot: () => { queue: Track[]; index: number };
  play: (tracks: Track[]) => Promise<void>;
  append: (tracks: Track[]) => void;
  /** Keep what is playing, replace everything after it, and move on to the new songs. */
  replaceUpcoming: (tracks: Track[]) => Promise<void>;
}

export interface RadioDeps {
  provider: () => Promise<{ ref: string }>;
  profile: () => Promise<TasteProfile>;
  /** The DJ's set planner (asks the model, keeps only songs that exist). */
  plan: (ref: string, profile: TasteProfile, opts: DjSetOptions) => Promise<DjTrack[]>;
  player: PlayerPort;
  /** Turn the regular DJ off so the two don't fight over the queue. */
  stopDj: () => void;
  speak: (text: string) => void;
  stopSpeaking: () => void;
  hostStyle: () => string | undefined;
  now: () => number;
}

export interface RadioState {
  status: "off" | "starting" | "on";
  mood: MoodId | "custom" | null;
  custom: string;
  /** Planning the next set. */
  planning: boolean;
  error: unknown;
  /** A line about what the radio just did, e.g. why it changed direction. */
  notice: string | null;
  spoken: boolean;
  skipped: number;
  finished: number;
  setCustom: (text: string) => void;
  setSpoken: (on: boolean) => void;
  start: (mood: MoodId | "custom") => Promise<void>;
  changeDirection: (reason?: string) => Promise<void>;
  stop: (notice?: string) => void;
  /** Feed playback events from the plugin host. */
  onPlayback: (e: PlaybackEvent) => void;
}

export function createRadioStore(deps: RadioDeps) {
  let session = 0;
  let history: DjTrack[] = [];
  let intros = new Map<string, string>();
  let radioIds = new Set<string>();
  let profile: TasteProfile | null = null;
  let lastSwitchAt = -Infinity;
  /** A change of direction asked for while a set was being fetched; done as soon as that finishes. */
  let pendingSwitch: string | null = null;
  let tracker = new ListenTracker((id) => radioIds.has(id));

  return create<RadioState>((set, get) => {
    function newTracker() {
      tracker = new ListenTracker(
        (id) => radioIds.has(id),
        () => {
          set(tracker.counts());
          if (get().status === "on" && shouldSwitchUp(tracker.skipStreak(), lastSwitchAt, deps.now())) {
            void get().changeDirection("You skipped a few in a row, so the radio is changing direction.");
          }
        },
      );
    }
    newTracker();

    /** Ask for a set and remember it. Returns null if the radio was stopped or restarted meanwhile. */
    async function fetchSet(switchUp: boolean): Promise<DjTrack[] | null> {
      const id = session;
      const { mood, custom } = get();
      if (!mood) return null;
      const { ref } = await deps.provider();
      profile ??= await deps.profile();
      const next = await deps.plan(ref, profile, {
        mood: moodPrompt(mood, custom) || undefined,
        switchUp,
        count: SET_SIZE,
        history,
        style: deps.hostStyle(),
        notes: feedbackNotes(tracker.reactions),
      });
      if (id !== session) return null;
      history = [...history, ...next];
      for (const d of next) {
        radioIds.add(d.track.id);
        if (d.intro) intros.set(d.track.id, d.intro);
      }
      return next;
    }

    async function refill() {
      if (get().status !== "on" || get().planning) return;
      set({ planning: true });
      const id = session;
      try {
        const next = await fetchSet(false);
        if (next) deps.player.append(next.map((d) => d.track));
      } catch (e) {
        // A failed top-up keeps the music going; the error is shown and the next track tries again.
        if (id === session) set({ error: e });
      } finally {
        if (id === session) {
          set({ planning: false });
          const again = pendingSwitch;
          pendingSwitch = null;
          if (again) void get().changeDirection(again);
        }
      }
    }

    return {
      status: "off",
      mood: null,
      custom: "",
      planning: false,
      error: null,
      notice: null,
      spoken: false,
      skipped: 0,
      finished: 0,

      setCustom: (custom) => set({ custom }),
      setSpoken(spoken) {
        set({ spoken });
        if (!spoken) deps.stopSpeaking();
      },

      async start(mood) {
        if (mood === "custom" && !moodPrompt("custom", get().custom)) {
          set({ error: new Error("Describe the mood first, for example: rainy late-night drive.") });
          return;
        }
        deps.stopDj();
        session++;
        const id = session;
        history = [];
        intros = new Map();
        radioIds = new Set();
        profile = null;
        lastSwitchAt = -Infinity;
        pendingSwitch = null;
        newTracker();
        set({ status: "starting", mood, error: null, notice: null, planning: true, skipped: 0, finished: 0 });
        try {
          const first = await fetchSet(false);
          if (!first || id !== session) return;
          await deps.player.play(first.map((d) => d.track));
          set({ status: "on", planning: false });
        } catch (e) {
          if (id === session) set({ status: "off", planning: false, error: e });
        }
      },

      async changeDirection(reason) {
        if (get().status !== "on") return;
        if (get().planning) {
          pendingSwitch = reason ?? "Changing direction…";
          return;
        }
        const id = session;
        lastSwitchAt = deps.now();
        tracker.resetStreak();
        set({ planning: true, notice: reason ?? "Changing direction…" });
        try {
          const next = await fetchSet(true);
          if (next) await deps.player.replaceUpcoming(next.map((d) => d.track));
        } catch (e) {
          if (id === session) set({ error: e, notice: null });
        } finally {
          if (id === session) set({ planning: false });
        }
      },

      stop(notice) {
        tracker.flush();
        session++;
        pendingSwitch = null;
        deps.stopSpeaking();
        set({ status: "off", planning: false, notice: notice ?? null });
      },

      onPlayback(e) {
        if (get().status === "off") return;
        tracker.handle(e);
        if (e.kind !== "track" || !e.track) return;
        if (get().status === "starting") return;
        if (!radioIds.has(e.track.id)) {
          get().stop("You played something else, so the radio stopped.");
          return;
        }
        const intro = intros.get(e.track.id);
        if (get().spoken && intro) deps.speak(intro);
        const { queue, index } = deps.player.snapshot();
        if (upcoming(queue.length, index) <= REFILL_AT) void refill();
      },
    };
  });
}

export type { Reaction };
