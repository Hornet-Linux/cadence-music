/** Spectrum and waveform maths for the visualizer. Pure, so it can be tested without audio. */

/** Edges (Hz) of `count` log-spaced bands between fMin and fMax: count + 1 numbers. */
export function bandEdges(count: number, fMin = 40, fMax = 14000): number[] {
  const lo = Math.log(fMin);
  const hi = Math.log(fMax);
  return Array.from({ length: count + 1 }, (_, i) => Math.exp(lo + ((hi - lo) * i) / count));
}

/**
 * Average the analyser's frequency bytes (0-255, already on a dB scale) into `count` log bands,
 * as levels 0..1. A mild curve keeps quiet detail visible without making loud peaks jump.
 */
export function bandLevels(data: ArrayLike<number>, sampleRate: number, count: number, fMin = 40, fMax = 14000): number[] {
  const edges = bandEdges(count, fMin, fMax);
  const binHz = sampleRate / 2 / data.length;
  return Array.from({ length: count }, (_, i) => {
    const from = Math.max(0, Math.floor(edges[i] / binHz));
    const to = Math.min(data.length, Math.max(from + 1, Math.ceil(edges[i + 1] / binHz)));
    let sum = 0;
    for (let b = from; b < to; b++) sum += data[b];
    const mean = sum / (to - from) / 255;
    return Math.pow(Math.min(1, Math.max(0, mean)), 1.3);
  });
}

/**
 * Move `prev` towards `next`. Rising is quicker than falling, but both are limited, so a sudden
 * loud hit never makes the picture flash.
 */
export function smoothLevels(prev: number[], next: number[], attack = 0.35, release = 0.08): number[] {
  return next.map((n, i) => {
    const p = prev[i] ?? 0;
    return p + (n - p) * (n > p ? attack : release);
  });
}

/** Downsample the waveform bytes (128 = silence) to `points` values in -1..1. */
export function waveformPoints(data: ArrayLike<number>, points: number): number[] {
  if (data.length === 0 || points <= 0) return [];
  const step = data.length / points;
  return Array.from({ length: points }, (_, i) => {
    const from = Math.floor(i * step);
    const to = Math.max(from + 1, Math.floor((i + 1) * step));
    let sum = 0;
    for (let k = from; k < to && k < data.length; k++) sum += data[k];
    return Math.max(-1, Math.min(1, (sum / (to - from) - 128) / 128));
  });
}

export const peakOf = (levels: number[]) => levels.reduce((m, v) => Math.max(m, v), 0);

export type Motion = "calm" | "still";

/** Milliseconds between redraws. "still" only refreshes once a second. */
export const FRAME_MS: Record<Motion, number> = { calm: 50, still: 1000 };
/** How strongly levels follow the music. "still" averages heavily. */
export const SMOOTHING: Record<Motion, { attack: number; release: number }> = {
  calm: { attack: 0.3, release: 0.07 },
  still: { attack: 0.15, release: 0.15 },
};
