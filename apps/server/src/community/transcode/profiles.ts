export interface Profile {
  id: string;
  label: string;
  /** Target bitrate in kbit/s. */
  kbps: number;
  /** ffmpeg audio encoder that must exist. */
  encoder: "libopus" | "aac" | "libmp3lame";
  ext: "opus" | "aac" | "mp3";
  mime: string;
  /** ffmpeg output arguments (after the input), without the output path. */
  args: string[];
}

const opus = (kbps: number): Profile => ({
  id: `opus-${kbps}`,
  label: `Opus ${kbps} kbps`,
  kbps,
  encoder: "libopus",
  ext: "opus",
  mime: "audio/ogg",
  args: ["-c:a", "libopus", "-b:a", `${kbps}k`, "-vbr", "on", "-application", "audio", "-ac", "2", "-f", "ogg"],
});

const aac = (kbps: number): Profile => ({
  id: `aac-${kbps}`,
  label: `AAC ${kbps} kbps`,
  kbps,
  encoder: "aac",
  ext: "aac",
  mime: "audio/aac",
  args: ["-c:a", "aac", "-b:a", `${kbps}k`, "-ac", "2", "-f", "adts"],
});

const mp3 = (kbps: number): Profile => ({
  id: `mp3-${kbps}`,
  label: `MP3 ${kbps} kbps`,
  kbps,
  encoder: "libmp3lame",
  ext: "mp3",
  mime: "audio/mpeg",
  args: ["-c:a", "libmp3lame", "-b:a", `${kbps}k`, "-ac", "2", "-id3v2_version", "0", "-f", "mp3"],
});

/** Streaming profiles, from lightest to heaviest. `original` (no transcoding) is always available. */
export const PROFILES: Profile[] = [opus(64), opus(96), opus(128), aac(128), aac(192), mp3(128), mp3(192)];

export const profileById = (id: string | undefined): Profile | undefined => PROFILES.find((p) => p.id === id);

/** Formats that are already compressed: transcoding them to a higher bitrate only wastes CPU. */
const LOSSY_EXT = new Set([".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus"]);

/**
 * Skip transcoding when the source is a lossy file that is already at or below the target bitrate.
 * Without a known duration there is no way to tell, so the file is transcoded.
 */
export function alreadySmall(ext: string, sizeBytes: number, durationSec: number | null, profile: Profile): boolean {
  if (!LOSSY_EXT.has(ext.toLowerCase()) || !durationSec || durationSec <= 0) return false;
  const kbps = (sizeBytes * 8) / durationSec / 1000;
  return kbps <= profile.kbps * 1.05;
}