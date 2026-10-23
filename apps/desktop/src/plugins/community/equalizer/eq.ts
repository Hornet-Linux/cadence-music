/** 10-band equalizer maths and presets. No audio objects in here, so it is easy to test. */

export const BAND_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
export const BAND_COUNT = BAND_FREQS.length;
export const MAX_GAIN_DB = 12;
export const MAX_PREAMP_DB = 12;
/** About one octave per band. */
export const BAND_Q = 1.41;

export type Gains = number[];

export interface EqPreset {
  name: string;
  preamp: number;
  gains: Gains;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Cutting the preamp by half the biggest boost keeps loud music from clipping. */
export function headroomFor(gains: Gains): number {
  const peak = Math.max(0, ...gains);
  return -round1(Math.min(MAX_PREAMP_DB, peak / 2));
}

const preset = (name: string, gains: Gains): EqPreset => ({ name, gains, preamp: headroomFor(gains) });

export const BUILT_IN_PRESETS: EqPreset[] = [
  preset("Flat", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  preset("Bass boost", [6, 5, 4, 2, 0, 0, 0, 0, 0, 0]),
  preset("Treble boost", [0, 0, 0, 0, 0, 1, 2, 4, 5, 6]),
  preset("Vocal", [-2, -2, -1, 1, 3, 4, 3, 2, 0, -1]),
  preset("Acoustic", [4, 4, 3, 1, 1, 1, 2, 3, 3, 2]),
  preset("Electronic", [5, 4, 1, 0, -2, 2, 1, 1, 4, 5]),
  preset("Loudness", [6, 4, 0, 0, -1, 0, -1, 0, 3, 5]),
  preset("Late night", [-4, -3, -1, 0, 1, 2, 2, 0, -2, -4]),
];

export interface EqSettings {
  /** False = bypass without removing the plugin. */
  on: boolean;
  preamp: number;
  gains: Gains;
  /** Name of the preset last applied (built-in or custom), or "" once edited by hand. */
  preset: string;
  custom: EqPreset[];
}

export const DEFAULT_EQ: EqSettings = { on: true, preamp: 0, gains: Array(BAND_COUNT).fill(0), preset: "Flat", custom: [] };

const clamp = (v: unknown, lo: number, hi: number) => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return Math.min(hi, Math.max(lo, n));
};

export function sanitizeGains(gains: unknown): Gains {
  const list = Array.isArray(gains) ? gains : [];
  return Array.from({ length: BAND_COUNT }, (_, i) => round1(clamp(list[i], -MAX_GAIN_DB, MAX_GAIN_DB)));
}

/** Make anything read from storage safe to use. */
export function sanitizeSettings(raw: Partial<EqSettings> | null | undefined): EqSettings {
  const r = raw ?? {};
  const custom = (Array.isArray(r.custom) ? r.custom : [])
    .filter((p): p is EqPreset => !!p && typeof p.name === "string" && p.name.trim().length > 0)
    .slice(0, 20)
    .map((p) => ({ name: p.name.trim().slice(0, 32), preamp: round1(clamp(p.preamp, -MAX_PREAMP_DB, MAX_PREAMP_DB)), gains: sanitizeGains(p.gains) }));
  return {
    on: r.on !== false,
    preamp: round1(clamp(r.preamp, -MAX_PREAMP_DB, MAX_PREAMP_DB)),
    gains: r.gains ? sanitizeGains(r.gains) : [...DEFAULT_EQ.gains],
    preset: typeof r.preset === "string" ? r.preset : "",
    custom,
  };
}

/** The preset that exactly matches these settings, or "" when edited by hand. */
export function matchPreset(preamp: number, gains: Gains, custom: EqPreset[] = []): string {
  const same = (p: EqPreset) => p.preamp === preamp && p.gains.length === gains.length && p.gains.every((g, i) => g === gains[i]);
  return [...BUILT_IN_PRESETS, ...custom].find(same)?.name ?? "";
}

/**
 * Save the current curve under `name`. A name equal to a built-in preset is refused
 * (returns the list unchanged); an existing custom name is overwritten.
 */
export function savePreset(custom: EqPreset[], name: string, preamp: number, gains: Gains): EqPreset[] {
  const clean = name.trim().slice(0, 32);
  if (!clean) return custom;
  if (BUILT_IN_PRESETS.some((p) => p.name.toLowerCase() === clean.toLowerCase())) return custom;
  const entry: EqPreset = { name: clean, preamp, gains: [...gains] };
  const without = custom.filter((p) => p.name.toLowerCase() !== clean.toLowerCase());
  return [...without, entry].slice(-20);
}

export const dbToGain = (db: number) => 10 ** (db / 20);

export type BandType = "lowshelf" | "peaking" | "highshelf";
export const bandType = (i: number): BandType => (i === 0 ? "lowshelf" : i === BAND_COUNT - 1 ? "highshelf" : "peaking");

/**
 * Magnitude (dB) of one RBJ biquad band at frequency `f`, for drawing the curve.
 * This is the same filter the browser's BiquadFilterNode implements.
 */
export function bandResponseDb(type: BandType, f0: number, gainDb: number, q: number, f: number, sampleRate = 48000): number {
  if (gainDb === 0) return 0;
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (type === "peaking") {
    b0 = 1 + alpha * A;
    b1 = -2 * cos;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cos;
    a2 = 1 - alpha / A;
  } else {
    // Shelves, with the slope fixed by Q as the Web Audio spec does.
    const beta = 2 * Math.sqrt(A) * alpha;
    if (type === "lowshelf") {
      b0 = A * (A + 1 - (A - 1) * cos + beta);
      b1 = 2 * A * (A - 1 - (A + 1) * cos);
      b2 = A * (A + 1 - (A - 1) * cos - beta);
      a0 = A + 1 + (A - 1) * cos + beta;
      a1 = -2 * (A - 1 + (A + 1) * cos);
      a2 = A + 1 + (A - 1) * cos - beta;
    } else {
      b0 = A * (A + 1 + (A - 1) * cos + beta);
      b1 = -2 * A * (A - 1 + (A + 1) * cos);
      b2 = A * (A + 1 + (A - 1) * cos - beta);
      a0 = A + 1 - (A - 1) * cos + beta;
      a1 = 2 * (A - 1 - (A + 1) * cos);
      a2 = A + 1 - (A - 1) * cos - beta;
    }
  }
  const w = (2 * Math.PI * f) / sampleRate;
  const cw = Math.cos(w);
  const c2w = Math.cos(2 * w);
  const sw = Math.sin(w);
  const s2w = Math.sin(2 * w);
  const numRe = b0 + b1 * cw + b2 * c2w;
  const numIm = -(b1 * sw + b2 * s2w);
  const denRe = a0 + a1 * cw + a2 * c2w;
  const denIm = -(a1 * sw + a2 * s2w);
  const mag = Math.sqrt((numRe ** 2 + numIm ** 2) / (denRe ** 2 + denIm ** 2));
  return 20 * Math.log10(mag);
}

/** Combined response of all bands (without the preamp) at `f`. */
export function totalResponseDb(gains: Gains, f: number): number {
  let sum = 0;
  for (let i = 0; i < BAND_COUNT; i++) sum += bandResponseDb(bandType(i), BAND_FREQS[i], gains[i] ?? 0, BAND_Q, f);
  return sum;
}

/** Points for the curve on a log-frequency axis from 20 Hz to 20 kHz. */
export function responseCurve(gains: Gains, preamp: number, points = 64): { f: number; db: number }[] {
  const lo = Math.log10(20);
  const hi = Math.log10(20000);
  return Array.from({ length: points }, (_, i) => {
    const f = 10 ** (lo + ((hi - lo) * i) / (points - 1));
    return { f, db: totalResponseDb(gains, f) + preamp };
  });
}

export function formatHz(f: number): string {
  return f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`;
}

export function formatDb(db: number): string {
  const v = round1(db);
  return `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
}
