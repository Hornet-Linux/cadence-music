/**
 * Headphone crossfeed and a simple stereo widener share one topology: each output channel is
 * its own channel (`direct`) plus some of the opposite channel (`cross`).
 *
 *   L' = direct * L + cross * R        R' = direct * R + cross * L
 *
 * Crossfeed sends a softened, slightly delayed copy of the other side (what your ears would
 * hear from speakers), so hard-panned old stereo records stop sounding like they are inside
 * your head. The widener does the opposite with a plain mid/side change.
 */

export type StereoMode = "off" | "crossfeed" | "widen";

export interface StereoSettings {
  mode: StereoMode;
  /** Crossfeed strength 0..1. */
  feed: number;
  /** Stereo width 0..2 (1 = unchanged, 0 = mono, 2 = twice as wide). */
  width: number;
}

export const DEFAULT_STEREO: StereoSettings = { mode: "crossfeed", feed: 0.45, width: 1.4 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

export function sanitizeStereo(s: StereoSettings): StereoSettings {
  return {
    mode: s.mode === "off" || s.mode === "widen" ? s.mode : "crossfeed",
    feed: Math.round(clamp(s.feed, 0, 1) * 20) / 20,
    width: Math.round(clamp(s.width, 0, 2) * 20) / 20,
  };
}

export interface MatrixGains {
  direct: number;
  cross: number;
  /** Low-pass cutoff on the cross path in Hz (high = no filtering). */
  cutoff: number;
  /** Delay on the cross path in seconds. */
  delay: number;
}

/**
 * Crossfeed: the cross path is up to about -4.5 dB (strength 1) of the other channel, low-passed
 * around 700 Hz (the head shadows highs) and delayed about 0.3 ms. Dividing by (1 + cross)
 * keeps a centred sound at the same level.
 */
export function crossfeedGains(strength: number): MatrixGains {
  const s = clamp(strength, 0, 1);
  const cross = 0.6 * s;
  const norm = 1 / (1 + cross);
  return { direct: norm, cross: cross * norm, cutoff: 700, delay: 0.0003 };
}

/**
 * Widener from mid/side: M = (L+R)/2, S = (L-R)/2 * width, L' = M+S, R' = M-S, so
 * direct = (1+w)/2 and cross = (1-w)/2. A centred sound (L = R) never changes level.
 */
export function widenerGains(width: number): MatrixGains {
  const w = clamp(width, 0, 2);
  return { direct: (1 + w) / 2, cross: (1 - w) / 2, cutoff: 20000, delay: 0 };
}

export function gainsFor(s: StereoSettings): MatrixGains {
  if (s.mode === "off") return { direct: 1, cross: 0, cutoff: 20000, delay: 0 };
  return s.mode === "widen" ? widenerGains(s.width) : crossfeedGains(s.feed);
}

/** Simulate the matrix on one stereo sample (for tests and sanity checks). */
export function applyMatrix(g: Pick<MatrixGains, "direct" | "cross">, left: number, right: number): [number, number] {
  return [g.direct * left + g.cross * right, g.direct * right + g.cross * left];
}
