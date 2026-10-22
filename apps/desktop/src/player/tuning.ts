import { create } from "zustand";

/**
 * Playback knobs that plugins turn and the player obeys. Everything here resets to the
 * default when the plugin that set it is disabled, so a default player behaves as before.
 * Only plain media (the <audio> element) honours crossfade, gapless, speed and pitch;
 * Spotify / Apple Music playback ignores them. `masterGain` and `stopAfterTrack` apply to
 * every source.
 */
export interface Tuning {
  /** Seconds of overlap between tracks; 0 = off. */
  crossfadeSec: number;
  /** Start the next track the instant this one ends (and buffer it ahead of time). */
  gapless: boolean;
  /** Playback speed, 1 = normal. */
  rate: number;
  /** Keep the pitch while the speed changes (false = tape-style, pitch follows speed). */
  preservePitch: boolean;
  /** Extra volume multiplier 0..1 (used by the sleep timer's fade-out). */
  masterGain: number;
  /** Pause when the current track finishes instead of moving on. */
  stopAfterTrack: boolean;
}

export const DEFAULT_TUNING: Tuning = {
  crossfadeSec: 0,
  gapless: false,
  rate: 1,
  preservePitch: true,
  masterGain: 1,
  stopAfterTrack: false,
};

export const MAX_CROSSFADE_SEC = 12;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

interface TuningStore extends Tuning {
  set: (patch: Partial<Tuning>) => void;
  reset: (keys?: (keyof Tuning)[]) => void;
}

export const useTuning = create<TuningStore>((set) => ({
  ...DEFAULT_TUNING,
  set(patch) {
    const next: Partial<Tuning> = { ...patch };
    if (patch.crossfadeSec !== undefined) next.crossfadeSec = clamp(patch.crossfadeSec, 0, MAX_CROSSFADE_SEC);
    if (patch.rate !== undefined) next.rate = clamp(patch.rate, 0.25, 4);
    if (patch.masterGain !== undefined) next.masterGain = clamp(patch.masterGain, 0, 1);
    set(next);
  },
  reset(keys) {
    if (!keys) return set({ ...DEFAULT_TUNING });
    const patch: Partial<Tuning> = {};
    for (const k of keys) (patch as Record<string, unknown>)[k] = DEFAULT_TUNING[k];
    set(patch);
  },
}));
