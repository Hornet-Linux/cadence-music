/**
 * Small, dependency-free audio feature estimators (tempo, energy, musical key) that work on
 * mono PCM decoded by ffmpeg. They are estimates tuned to be right most of the time on typical
 * music, not studio-grade analysis: tempo can come out at half or double speed on unusual material.
 */

export const SAMPLE_RATE = 22050;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// ---------------------------------------------------------------------------------------------
// Tempo

const HOP = 256;

/** Frame energies -> onset strength (positive changes of log energy, minus a local average). */
export function onsetEnvelope(samples: Float32Array): Float32Array {
  const frames = Math.floor(samples.length / HOP);
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    // A first difference favours the bright, percussive part of the spectrum.
    for (let i = f * HOP + 1; i < (f + 1) * HOP; i++) {
      const d = samples[i]! - samples[i - 1]!;
      sum += d * d;
    }
    energy[f] = Math.log(1 + 40 * Math.sqrt(sum / HOP));
  }
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) onset[f] = Math.max(0, energy[f]! - energy[f - 1]!);
  // Remove the slowly varying background (about half a second wide).
  const w = 43;
  const out = new Float32Array(frames);
  let running = 0;
  for (let f = 0; f < frames; f++) {
    running += onset[f]!;
    if (f >= w) running -= onset[f - w]!;
    out[f] = Math.max(0, onset[f]! - running / Math.min(f + 1, w) - 0.02);
  }
  return out;
}

export interface Tempo {
  bpm: number;
  /** 0..1, how clearly periodic the music is. */
  confidence: number;
}

export function estimateTempo(samples: Float32Array, minBpm = 60, maxBpm = 200): Tempo | null {
  const onset = onsetEnvelope(samples);
  const n = onset.length;
  const fps = SAMPLE_RATE / HOP;
  if (n < fps * 8) return null;

  const maxLag = Math.ceil((fps * 60) / minBpm) * 4 + 2;
  const acf = new Float32Array(Math.min(maxLag, n - 1));
  for (let lag = 0; lag < acf.length; lag++) {
    let sum = 0;
    for (let i = lag; i < n; i++) sum += onset[i]! * onset[i - lag]!;
    acf[lag] = sum / (n - lag);
  }
  if (acf[0]! <= 1e-9) return null;
  const at = (lag: number) => {
    if (lag < 0 || lag >= acf.length - 1) return 0;
    const i = Math.floor(lag);
    return acf[i]! + (acf[i + 1]! - acf[i]!) * (lag - i);
  };

  let best = { bpm: 0, score: -1, raw: 0 };
  let total = 0;
  let count = 0;
  for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.25) {
    const lag = (fps * 60) / bpm;
    // The beat itself plus its multiples: a steady pulse repeats at every one.
    const raw = at(lag) + 0.5 * at(lag * 2) + 0.25 * at(lag * 4);
    // Mild preference for the tempo range most music sits in.
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.6) ** 2);
    const score = raw * prior;
    total += score;
    count++;
    if (score > best.score) best = { bpm, score, raw };
  }
  if (best.bpm === 0) return null;
  const mean = total / count;
  const peaky = mean > 0 ? best.score / mean : 0;
  const confidence = clamp01((peaky - 1) / 4) * clamp01((best.raw / acf[0]!) * 3 + 0.2);
  return { bpm: Math.round(best.bpm * 10) / 10, confidence: Math.round(confidence * 100) / 100 };
}

// ---------------------------------------------------------------------------------------------
// Energy

/** 0..1: louder, brighter, busier music scores higher. A rough stand-in for "how energetic does it feel". */
export function estimateEnergy(samples: Float32Array): number {
  if (samples.length < SAMPLE_RATE) return 0;
  let sumSq = 0;
  let crossings = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    sumSq += s * s;
    if (i > 0 && s >= 0 !== samples[i - 1]! >= 0) crossings++;
  }
  const rmsDb = 20 * Math.log10(Math.sqrt(sumSq / samples.length) + 1e-9);
  const loudness = clamp01((rmsDb + 36) / 24); // -36 dBFS -> 0, -12 dBFS -> 1
  const brightness = clamp01(crossings / samples.length / 0.18);
  const onset = onsetEnvelope(samples);
  let mean = 0;
  for (const o of onset) mean += o;
  mean /= Math.max(1, onset.length);
  let peaks = 0;
  for (let i = 1; i < onset.length - 1; i++) {
    if (onset[i]! > mean * 2.5 && onset[i]! >= onset[i - 1]! && onset[i]! > onset[i + 1]!) peaks++;
  }
  const activity = clamp01(peaks / (samples.length / SAMPLE_RATE) / 5);
  return Math.round((0.55 * loudness + 0.2 * brightness + 0.25 * activity) * 100) / 100;
}

// ---------------------------------------------------------------------------------------------
// Key

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

const FFT_SIZE = 8192;

/** Energy per pitch class (C, C#, ... B), summed over the whole clip. */
export function chromagram(samples: Float32Array): Float64Array {
  const chroma = new Float64Array(12);
  const window = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const binHz = SAMPLE_RATE / FFT_SIZE;
  const lo = Math.ceil(65 / binHz);
  const hi = Math.floor(2100 / binHz);
  const pitchClass = new Int8Array(hi + 1);
  for (let b = lo; b <= hi; b++) pitchClass[b] = (((Math.round(12 * Math.log2((b * binHz) / 440)) + 9) % 12) + 12) % 12;
  for (let start = 0; start + FFT_SIZE <= samples.length; start += FFT_SIZE) {
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = samples[start + i]! * window[i]!;
      im[i] = 0;
    }
    fft(re, im);
    const frame = new Float64Array(12);
    let peak = 0;
    for (let b = lo; b <= hi; b++) {
      const mag = Math.hypot(re[b]!, im[b]!);
      // Count only bins that stand out from their neighbours (pitched partials, not noise).
      if (mag > Math.hypot(re[b - 1]!, im[b - 1]!) && mag >= Math.hypot(re[b + 1]!, im[b + 1]!)) {
        frame[pitchClass[b]!]! += Math.sqrt(mag);
        peak = Math.max(peak, frame[pitchClass[b]!]!);
      }
    }
    if (peak > 0) for (let p = 0; p < 12; p++) chroma[p]! += frame[p]! / peak;
  }
  return chroma;
}

// Krumhansl-Kessler key profiles.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const CAMELOT_MAJOR = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];
const CAMELOT_MINOR = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];

export interface KeyEstimate {
  /** For example "A minor". */
  key: string;
  /** Camelot wheel code used by DJs, for example "8A". */
  camelot: string;
  /** 0..1, how far the best key stands out from the runner-up. */
  confidence: number;
}

function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

export function keyFromChroma(chroma: ArrayLike<number>): KeyEstimate | null {
  let total = 0;
  for (let i = 0; i < 12; i++) total += chroma[i]!;
  if (total <= 0) return null;
  const scores: { tonic: number; minor: boolean; r: number }[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotate = (profile: number[]) => Array.from({ length: 12 }, (_, i) => profile[(i - tonic + 12) % 12]!);
    scores.push({ tonic, minor: false, r: correlation(chroma, rotate(MAJOR)) });
    scores.push({ tonic, minor: true, r: correlation(chroma, rotate(MINOR)) });
  }
  scores.sort((a, b) => b.r - a.r);
  const best = scores[0]!;
  const runnerUp = scores[1]!;
  return {
    key: `${NAMES[best.tonic]} ${best.minor ? "minor" : "major"}`,
    camelot: (best.minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[best.tonic]!,
    confidence: Math.round(clamp01((best.r - runnerUp.r) * 6) * 100) / 100,
  };
}

export function estimateKey(samples: Float32Array): KeyEstimate | null {
  return keyFromChroma(chromagram(samples));
}

/** Camelot codes that mix harmonically with `code`: same, one step either way, or the relative major/minor. */
export function compatibleCamelot(code: string): string[] {
  const m = /^(\d{1,2})([AB])$/.exec(code);
  if (!m) return [];
  const n = Number(m[1]);
  const letter = m[2]!;
  const wrap = (x: number) => ((x - 1 + 12) % 12) + 1;
  return [code, `${wrap(n + 1)}${letter}`, `${wrap(n - 1)}${letter}`, `${n}${letter === "A" ? "B" : "A"}`];
}

export interface AudioFeatures {
  bpm: number | null;
  bpmConfidence: number | null;
  energy: number;
  key: string | null;
  camelot: string | null;
  keyConfidence: number | null;
}

export function analyzeSamples(samples: Float32Array): AudioFeatures {
  const tempo = estimateTempo(samples);
  const key = estimateKey(samples);
  return {
    bpm: tempo?.bpm ?? null,
    bpmConfidence: tempo?.confidence ?? null,
    energy: estimateEnergy(samples),
    key: key?.key ?? null,
    camelot: key?.camelot ?? null,
    keyConfidence: key?.confidence ?? null,
  };
}
