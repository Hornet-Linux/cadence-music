import path from "node:path";
import { parseBuffer } from "music-metadata";

/** Formats Chromium (and so the desktop app and Android WebView) can play, with the type to send. */
export const AUDIO_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};

export function isAudioName(name: string): boolean {
  return path.extname(name).toLowerCase() in AUDIO_TYPES;
}

export function contentTypeFor(name: string): string {
  return AUDIO_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

export interface Tags {
  title: string;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  trackNo: number | null;
  durationSec: number | null;
  /** True when the file's own tags were read; false when we only had the file name. */
  fromTags: boolean;
}

/** "03 - Song name.mp3" becomes "Song name". */
export function titleFromName(name: string): string {
  const base = path.posix.basename(name.replace(/\\/g, "/"));
  const noExt = base.slice(0, base.length - path.extname(base).length);
  const cleaned = noExt.replace(/^\s*\d{1,3}\s*[-_.)]\s*/, "").replace(/_/g, " ").trim();
  return cleaned || noExt || base;
}

export function fallbackTags(name: string): Tags {
  return { title: titleFromName(name), artist: null, album: null, albumArtist: null, trackNo: null, durationSec: null, fromTags: false };
}

/** How much of the start of a file is read to find its tags (most formats keep them there). */
export const HEAD_BYTES = 384 * 1024;

/** Size of an ID3v2 tag at the start of a buffer (0 when there is none). */
function id3Size(head: Buffer): number {
  if (head.length < 10 || head.toString("latin1", 0, 3) !== "ID3") return 0;
  return 10 + ((head[6]! & 0x7f) << 21) + ((head[7]! & 0x7f) << 14) + ((head[8]! & 0x7f) << 7) + (head[9]! & 0x7f);
}

/**
 * The reader only saw the start of the file. For MP3 it then counts just the frames it was given, so when
 * its answer only covers what it read, work the length out from the bit rate and the whole file size.
 */
function estimateDuration(format: { duration?: number; bitrate?: number; container?: string }, head: Buffer, size: number): number | undefined {
  const { duration, bitrate } = format;
  if (format.container !== "MPEG" || !bitrate || head.length >= size) return duration;
  const scanned = ((duration ?? 0) * bitrate) / 8;
  if (duration && scanned > head.length * 1.05) return duration; // a VBR header gave the real length
  return Math.max(0, size - id3Size(head)) * 8 / bitrate;
}

/**
 * Reads tags from the start of a file. `size` is the whole file's size, which lets the reader
 * estimate the length of an MP3 from its bit rate without downloading it.
 * Never throws: a file it cannot read gets a title from its name.
 */
export async function readTags(head: Buffer, name: string, size: number): Promise<Tags> {
  const fallback = fallbackTags(name);
  try {
    const meta = await parseBuffer(new Uint8Array(head.buffer, head.byteOffset, head.byteLength), { mimeType: contentTypeFor(name), size }, { duration: false, skipCovers: true });
    const c = meta.common;
    const duration = estimateDuration(meta.format, head, size);
    return {
      title: c.title?.trim() || fallback.title,
      artist: c.artist?.trim() || null,
      album: c.album?.trim() || null,
      albumArtist: c.albumartist?.trim() || null,
      trackNo: c.track?.no ?? null,
      durationSec: typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) / 1000 : null,
      fromTags: true,
    };
  } catch {
    return fallback;
  }
}
