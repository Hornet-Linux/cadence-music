import type { Track } from "@/shared/types";

/** Volume normalization maths: ReplayGain reading and compressor/limiter settings. */

export interface NormalizeSettings {
  /** Apply ReplayGain tags when the track carries them. */
  replayGain: boolean;
  mode: "track" | "album";
  /** Extra gain on top of ReplayGain (dB). */
  preGainDb: number;
  /** 0 = off .. 1 = firm. Gentle compression to even out loud and quiet passages. */
  leveling: number;
  /** Catch peaks so boosted music cannot clip. */
  limiter: boolean;
}

export const DEFAULT_NORMALIZE: NormalizeSettings = {
  replayGain: true,
  mode: "track",
  preGainDb: 0,
  leveling: 0.35,
  limiter: true,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

export function sanitizeNormalize(s: NormalizeSettings): NormalizeSettings {
  return {
    replayGain: s.replayGain !== false,
    mode: s.mode === "album" ? "album" : "track",
    preGainDb: Math.round(clamp(s.preGainDb, -12, 12) * 2) / 2,
    leveling: Math.round(clamp(s.leveling, 0, 1) * 20) / 20,
    limiter: s.limiter !== false,
  };
}

/** Parse "-6.50 dB", "+3.2", "−4 dB" (unicode minus) or a plain number. */
export function parseGainDb(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const m = value.replace("−", "-").match(/^\s*([+-]?\d+(?:[.,]\d+)?)\s*(?:db)?\s*$/i);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Peak sample value as a linear number (1.0 = full scale). */
function parsePeak(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value.replace(",", ".")) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

export interface ReplayGain {
  gainDb: number;
  /** Linear peak of the same scope, when tagged. */
  peak: number | null;
}

/**
 * Find ReplayGain data on a track. The server does not send it yet, so this accepts the
 * shapes a server (or another plugin) is likely to add:
 *   track.replayGain = { trackGain, albumGain, trackPeak, albumPeak }
 *   track.replaygain_track_gain / replaygain_album_gain (+ _peak), as in file tags
 */
export function readReplayGain(track: Track | null, mode: "track" | "album"): ReplayGain | null {
  if (!track) return null;
  const t = track as unknown as Record<string, unknown>;
  const rg = (t.replayGain ?? t.replaygain ?? null) as Record<string, unknown> | null;
  const pick = (kind: "track" | "album") => {
    const gain =
      parseGainDb(rg?.[`${kind}Gain`]) ?? parseGainDb(t[`replaygain_${kind}_gain`]) ?? parseGainDb(t[`rg${kind[0].toUpperCase()}${kind.slice(1)}Gain`]);
    const peak = parsePeak(rg?.[`${kind}Peak`]) ?? parsePeak(t[`replaygain_${kind}_peak`]);
    return gain === null ? null : { gainDb: gain, peak };
  };
  // Album mode falls back to the track value; track mode to the album value.
  return mode === "album" ? (pick("album") ?? pick("track")) : (pick("track") ?? pick("album"));
}

/** The gain (dB) to apply: tag + pre-gain, never boosting a tagged peak past full scale. */
export function replayGainToApply(rg: ReplayGain | null, preGainDb: number): number {
  if (!rg) return 0;
  let db = clamp(rg.gainDb + preGainDb, -24, 12);
  if (rg.peak) {
    const maxDb = -20 * Math.log10(rg.peak);
    if (db > maxDb) db = maxDb;
  }
  return db;
}

export interface CompressorParams {
  threshold: number;
  knee: number;
  ratio: number;
  attack: number;
  release: number;
  /** Make-up gain (dB) so levelled music is not left quieter. */
  makeupDb: number;
}

/** Leveling amount 0..1 -> gentle compressor settings. 0 is a transparent pass-through. */
export function levelingParams(amount: number): CompressorParams {
  const a = clamp(amount, 0, 1);
  if (a === 0) return { threshold: 0, knee: 0, ratio: 1, attack: 0.01, release: 0.25, makeupDb: 0 };
  const threshold = -16 - 14 * a;
  const ratio = 1 + 3 * a;
  return { threshold, knee: 24, ratio, attack: 0.012, release: 0.28, makeupDb: Math.round(-threshold * (1 - 1 / ratio) * 0.4 * 10) / 10 };
}

/** A fast, hard compressor that only acts on peaks near full scale. */
export function limiterParams(on: boolean): Omit<CompressorParams, "makeupDb"> {
  return on
    ? { threshold: -1.5, knee: 0, ratio: 20, attack: 0.002, release: 0.09 }
    : { threshold: 0, knee: 0, ratio: 1, attack: 0.003, release: 0.25 };
}

export const dbToGain = (db: number) => 10 ** (db / 20);

export function formatGain(db: number): string {
  const v = Math.round(db * 10) / 10;
  return `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
}
