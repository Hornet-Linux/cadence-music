/**
 * Pure planning for moving from one track to the next (crossfade, gapless, pre-buffering).
 * The player calls `planTransition` a few times a second and does what it says; keeping the
 * decision free of audio elements and timers makes it easy to test.
 */

export interface TransitionInput {
  /** Seconds into the current track. */
  position: number;
  /** Track length in seconds (0 or NaN when unknown). */
  duration: number;
  /** Playback speed, so "seconds left" is measured in real time. */
  rate: number;
  crossfadeSec: number;
  gapless: boolean;
  /** There is a next track that plain audio could play. */
  hasNext: boolean;
  /** State of the pre-buffered next track. */
  next: "none" | "loading" | "ready";
  /** A crossfade is already running. */
  crossfading: boolean;
  /** The user asked to stop after this track. */
  stopAfterTrack: boolean;
}

export type TransitionPlan =
  | { kind: "none" }
  /** Resolve and buffer the next track now. */
  | { kind: "preload" }
  /** Start the next track underneath this one and blend over `seconds`. */
  | { kind: "crossfade"; seconds: number }
  /** Hand over to the next track right now (gapless). */
  | { kind: "switch" };

/** How far ahead the next track starts buffering. */
export const PRELOAD_LEAD_SEC = 20;
/** Gapless hand-over happens this many real seconds before the end (covers timer jitter). */
export const GAPLESS_LEAD_SEC = 0.12;
/** Crossfades shorter than this are pointless. */
const MIN_FADE_SEC = 0.5;

export function planTransition(i: TransitionInput): TransitionPlan {
  if (i.crossfading || i.stopAfterTrack || !i.hasNext) return { kind: "none" };
  if (!(i.duration > 0) || !Number.isFinite(i.duration)) return { kind: "none" };
  const rate = i.rate > 0 ? i.rate : 1;
  const left = Math.max(0, (i.duration - i.position) / rate);
  const wantsOverlap = i.crossfadeSec > 0;
  if (!wantsOverlap && !i.gapless) return { kind: "none" };

  // Never fade for longer than the song has left or than half of a short song.
  const fade = Math.min(i.crossfadeSec, i.duration / (2 * rate));
  const lead = wantsOverlap && fade >= MIN_FADE_SEC ? fade : 0;

  if (lead > 0 && left <= lead) return { kind: "crossfade", seconds: Math.max(MIN_FADE_SEC, left) };
  if (!wantsOverlap && left <= GAPLESS_LEAD_SEC) return { kind: "switch" };
  if (wantsOverlap && lead === 0 && left <= GAPLESS_LEAD_SEC) return { kind: "switch" };
  if (i.next === "none" && left <= lead + PRELOAD_LEAD_SEC) return { kind: "preload" };
  return { kind: "none" };
}

/** Equal-power fade curve: `progress` 0..1 -> gains for the outgoing and incoming track. */
export function crossfadeGains(progress: number): { out: number; in: number } {
  const p = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  return { out: Math.cos(p * Math.PI * 0.5), in: Math.sin(p * Math.PI * 0.5) };
}
