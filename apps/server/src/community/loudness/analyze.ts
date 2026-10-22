import { runFfmpeg } from "../_serverlib/ffmpeg.js";

export interface Loudness {
  /** Integrated loudness in LUFS (EBU R128), or null for silence. */
  lufs: number | null;
  /** Loudness range in LU. */
  lra: number | null;
  /** True peak in dBFS, or null for silence. */
  truePeakDb: number | null;
}

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null; // "-inf" parses to -Infinity and becomes null
};

/** Read the final "Summary" block ffmpeg's ebur128 filter prints on stderr. */
export function parseEbur128(stderr: string): Loudness | null {
  const at = stderr.lastIndexOf("Summary:");
  if (at < 0) return null;
  const summary = stderr.slice(at);
  const lufs = /^\s*I:\s+(-?[\d.]+|-?inf)\s+LUFS/m.exec(summary)?.[1];
  if (lufs === undefined) return null;
  return {
    lufs: num(lufs),
    lra: num(/^\s*LRA:\s+(-?[\d.]+|-?inf)\s+LU/m.exec(summary)?.[1]),
    truePeakDb: num(/^\s*(?:True\s+)?Peak:\s+(-?[\d.]+|-?inf)\s+dBFS/m.exec(summary)?.[1]),
  };
}

/** ReplayGain 2.0 reference level. */
export const TARGET_LUFS = -18;

/**
 * The gain (dB) that brings a track to the target loudness without pushing its peaks past -1 dBFS.
 * Silent tracks get no gain.
 */
export function replayGainDb(loudness: Pick<Loudness, "lufs" | "truePeakDb">, target = TARGET_LUFS): number | null {
  if (loudness.lufs === null) return null;
  let gain = target - loudness.lufs;
  if (loudness.truePeakDb !== null) gain = Math.min(gain, -1 - loudness.truePeakDb);
  return Math.round(Math.max(-40, Math.min(40, gain)) * 100) / 100;
}

/** Measure a file with ffmpeg (single thread, low priority). Throws with ffmpeg's message on failure. */
export async function analyzeLoudness(file: string, signal?: AbortSignal): Promise<Loudness> {
  const res = await runFfmpeg(
    ["-nostats", "-threads", "1", "-i", file, "-vn", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"],
    { timeoutMs: 10 * 60_000, signal },
  );
  if (signal?.aborted) throw new Error("stopped");
  if (res.error) throw new Error(res.error);
  const parsed = parseEbur128(res.stderr);
  if (res.code !== 0 || !parsed) {
    const last = res.stderr.trim().split("\n").filter(Boolean).slice(-2).join(" ");
    throw new Error(res.timedOut ? "analysis timed out" : last.slice(0, 200) || "ffmpeg failed");
  }
  return parsed;
}