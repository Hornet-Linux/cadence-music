/** A-B loop, speed and count-in maths for practising along. Pure, so it can be tested without audio. */

export interface Loop {
  a: number | null;
  b: number | null;
  enabled: boolean;
}

export const noLoop: Loop = { a: null, b: null, enabled: false };

/** The shortest loop that makes sense, in seconds. */
export const MIN_LOOP = 0.5;

export const RATES = [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1, 1.1, 1.25] as const;
export const MIN_RATE = 0.5;
export const MAX_RATE = 1.25;

export const clampRate = (rate: number): number => Math.round(Math.min(MAX_RATE, Math.max(MIN_RATE, rate)) * 100) / 100;

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Set point A at `position`. If B would no longer be after A, B is dropped. */
export function setA(loop: Loop, position: number, duration: number): Loop {
  const a = round1(Math.max(0, Math.min(position, duration > 0 ? duration : position)));
  const b = loop.b !== null && loop.b - a >= MIN_LOOP ? loop.b : null;
  return { a, b, enabled: b !== null };
}

/** Set point B at `position`. If A is missing or not before B, A becomes the start of the song. */
export function setB(loop: Loop, position: number, duration: number): Loop {
  const b = round1(Math.max(0, Math.min(position, duration > 0 ? duration : position)));
  let a = loop.a ?? 0;
  if (b - a < MIN_LOOP) a = Math.max(0, round1(b - Math.max(MIN_LOOP, 5)));
  if (b - a < MIN_LOOP) return { a: loop.a, b: null, enabled: false };
  return { a, b, enabled: true };
}

/** Move a loop point by `delta` seconds, keeping it inside the song and the loop at least MIN_LOOP long. */
export function nudge(loop: Loop, point: "a" | "b", delta: number, duration: number): Loop {
  if (loop.a === null || loop.b === null) return loop;
  const max = duration > 0 ? duration : Number.POSITIVE_INFINITY;
  if (point === "a") return { ...loop, a: round1(Math.min(Math.max(0, loop.a + delta), loop.b - MIN_LOOP)) };
  return { ...loop, b: round1(Math.max(Math.min(max, loop.b + delta), loop.a + MIN_LOOP)) };
}

export function isActive(loop: Loop): loop is Loop & { a: number; b: number } {
  return loop.enabled && loop.a !== null && loop.b !== null && loop.b - loop.a >= MIN_LOOP;
}

/**
 * Where to jump when the playhead reaches the end of the loop. `lookahead` jumps a little early,
 * which services with a coarse position clock (about once a second) need to avoid overshooting B.
 * Returns null when playback should carry on: not looping, or the person has deliberately moved
 * well past the loop.
 */
export function loopJump(position: number, loop: Loop, lookahead = 0.05): number | null {
  if (!isActive(loop)) return null;
  const overshoot = position - (loop.b - lookahead);
  if (overshoot >= 0 && overshoot < 2.5 + lookahead) return loop.a;
  return null;
}

/** Services with their own player report position about once a second and cannot change speed. */
export function isExternalSource(source: string | undefined): boolean {
  return source === "spotify" || source === "apple-music";
}

export interface CountIn {
  /** Seconds from the start at which each click sounds. */
  clicks: number[];
  /** Seconds until the music should start. */
  total: number;
}

/** Click times for a count-in of `beats` at `bpm`. */
export function countInPlan(bpm: number, beats: number): CountIn {
  const interval = 60 / clampBpm(bpm);
  const count = Math.min(8, Math.max(1, Math.round(beats)));
  return { clicks: Array.from({ length: count }, (_, i) => Math.round(i * interval * 1000) / 1000), total: Math.round(count * interval * 1000) / 1000 };
}

export const MIN_BPM = 40;
export const MAX_BPM = 240;
export const clampBpm = (bpm: number): number => Math.round(Math.min(MAX_BPM, Math.max(MIN_BPM, Number.isFinite(bpm) ? bpm : 100)));

/**
 * Tempo from tap times (milliseconds). Uses the last few taps and ignores a long pause before them.
 * Returns null until there are two taps.
 */
export function tapTempo(taps: number[]): number | null {
  const recent: number[] = [];
  for (let i = taps.length - 1; i >= 0 && recent.length < 6; i--) {
    if (recent.length > 0 && recent[0] - taps[i] > 2500) break; // a gap this long starts a new count
    recent.unshift(taps[i]);
  }
  if (recent.length < 2) return null;
  const average = (recent[recent.length - 1] - recent[0]) / (recent.length - 1);
  return clampBpm(60000 / average);
}

export function formatTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "--:--.-";
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}