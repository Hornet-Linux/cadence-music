import { clean } from "../_sourcekit/common.js";

/** Identifiers are letters, digits, dots, dashes and underscores. Anything else never goes into a URL. */
export const validIdentifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);

/** Redirects may only go to archive.org's own hosts (downloads are served from dn*.us.archive.org and the like). */
export function isArchiveHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "archive.org" || h.endsWith(".archive.org");
}

/**
 * Turns what a person typed into a safe Lucene query. Search syntax characters are dropped, so people can't reach
 * other fields or operators; the words are matched against title and creator.
 */
export function textQuery(input: string | undefined): string | null {
  const words = (input ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^-+|-+$/g, ""))
    .filter((w) => w.length > 0 && !/^(and|or|not|to)$/i.test(w))
    .slice(0, 8);
  if (words.length === 0) return null;
  const joined = words.map((w) => w.replace(/'/g, "")).join(" ");
  return `(title:(${joined}) OR creator:(${joined}))`;
}

const MP3 = /^(vbr mp3|(\d+kbps )?mp3|\d+kbps mp3|mp3)$/i;
export type AudioKind = "mp3" | "ogg" | "flac";

export function kindOfFormat(format: string | undefined): AudioKind | null {
  const f = (format ?? "").trim();
  if (MP3.test(f) || /mp3$/i.test(f)) return "mp3";
  if (/^(ogg vorbis|opus)$/i.test(f)) return "ogg";
  if (/^(flac|24bit flac)$/i.test(f)) return "flac";
  return null;
}

export interface ArchiveFile {
  name?: string;
  format?: string;
  title?: string;
  track?: string;
  length?: string;
  size?: string;
  source?: string;
  original?: string;
  creator?: string;
  album?: string;
}

export interface ArchiveTrack {
  file: string;
  title: string;
  track: number | null;
  durationSec: number;
  size: number;
  format: string;
}

function seconds(length: string | undefined): number {
  if (!length) return 0;
  const t = length.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t));
  const m = /^(?:(\d+):)?(\d+):(\d+)(?:\.\d+)?$/.exec(t);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

const natural = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/**
 * The playable tracks of an item in one format family (MP3 by default, falling back to Ogg, then FLAC),
 * in track order. File names are kept as given by the Archive; they are checked again when streaming.
 */
export function pickTracks(files: ArchiveFile[], prefer: AudioKind = "mp3"): { kind: AudioKind; tracks: ArchiveTrack[] } | null {
  const order: AudioKind[] = [prefer, ...(["mp3", "ogg", "flac"] as const).filter((k) => k !== prefer)];
  for (const kind of order) {
    const matching = files.filter((f) => typeof f.name === "string" && f.name.length > 0 && f.name.length < 300 && kindOfFormat(f.format) === kind);
    if (matching.length === 0) continue;
    // Several encodes of the same recording (e.g. VBR and 64Kbps): keep the best one per original.
    const byOriginal = new Map<string, ArchiveFile>();
    for (const f of matching) {
      const key = f.original ?? f.name!.replace(/\.[^.]+$/, "");
      const old = byOriginal.get(key);
      const vbr = (x: ArchiveFile) => (x.format ?? "").toLowerCase().startsWith("vbr");
      if (!old || (vbr(f) && !vbr(old)) || (vbr(f) === vbr(old) && (Number(f.size) || 0) > (Number(old.size) || 0))) byOriginal.set(key, f);
    }
    const tracks = [...byOriginal.values()]
      .map((f): ArchiveTrack => {
        const trackNo = Number.parseInt(String(f.track ?? "").split("/")[0], 10);
        return {
          file: f.name!,
          title: clean(f.title, 200) || clean(f.name!.replace(/\.[^.]+$/, "").replace(/_/g, " "), 200),
          track: Number.isFinite(trackNo) && trackNo > 0 ? trackNo : null,
          durationSec: seconds(f.length),
          size: Math.max(0, Number(f.size) || 0),
          format: clean(f.format, 40),
        };
      })
      .sort((a, b) => (a.track !== null && b.track !== null && a.track !== b.track ? a.track - b.track : natural(a.file, b.file)));
    return { kind, tracks: tracks.slice(0, 500) };
  }
  return null;
}

export interface Licence {
  name: string;
  url: string;
}

/** A readable licence from the item's licenseurl, e.g. "CC BY-NC-SA 3.0", "Public Domain". */
export function licenceOf(url: string | undefined): Licence | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const cc = /creativecommons\.org\/licenses\/([a-z-]+)\/([\d.]+)/i.exec(u.href);
  if (cc) return { name: `CC ${cc[1].toUpperCase()} ${cc[2]}`, url: u.href };
  if (/creativecommons\.org\/publicdomain\/zero/i.test(u.href)) return { name: "CC0 (public domain dedication)", url: u.href };
  if (/creativecommons\.org\/publicdomain\/mark/i.test(u.href)) return { name: "Public Domain Mark", url: u.href };
  if (/publicdomain/i.test(u.href)) return { name: "Public domain", url: u.href };
  return { name: u.hostname.replace(/^www\./, ""), url: u.href };
}