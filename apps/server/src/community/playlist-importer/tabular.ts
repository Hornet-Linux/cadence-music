import type { Wanted } from "./matcher.js";

/** What a file import yields: a wanted track plus how often it appeared (scrobble exports repeat songs). */
export interface ParsedItem extends Wanted {
  count?: number;
}

export type ImportFormat = "m3u" | "xspf" | "csv" | "json" | "itunes-xml";

export interface ParseResult {
  name?: string;
  format: ImportFormat;
  items: ParsedItem[];
  warnings: string[];
  /** For a library file with several playlists: the ones to choose from (items is empty until one is chosen). */
  choices?: { id: string; name: string; trackCount: number }[];
}

export const MAX_ITEMS = 20_000;
const MAX_TEXT = 300;

const clip = (s: unknown): string => (typeof s === "string" ? s.trim().slice(0, MAX_TEXT) : typeof s === "number" ? String(s) : "");

/** RFC 4180 CSV/TSV: quoted cells, doubled quotes, newlines inside quotes. Delimiter is guessed from the first line. */
export function parseDelimited(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const ch of firstLine) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch as keyof typeof counts]++;
  }
  const delimiter = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ",") as string;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") inQuotes = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const TITLE_KEYS = ["title", "track", "trackname", "name", "song", "songname", "tracktitle", "mastermetadatatrackname"];
const ARTIST_KEYS = ["artist", "artists", "artistname", "artistnames", "creator", "performer", "mastermetadataalbumartistname", "albumartist"];
const ALBUM_KEYS = ["album", "albumname", "release", "albumtitle", "mastermetadataalbumalbumname"];
const DURATION_KEYS = ["duration", "durationsec", "durationms", "length", "time", "tracklength", "totaltime", "trackduration", "durations"];

function pick(keys: string[], fields: Map<string, unknown>): unknown {
  for (const k of keys) if (fields.has(k) && fields.get(k) !== null && fields.get(k) !== "") return fields.get(k);
  return undefined;
}

/** "3:45", "1:02:03", "225", "225000" (ms) or 225 -> seconds. */
export function parseDuration(value: unknown, keyName = ""): number | undefined {
  if (typeof value === "number") return normaliseSeconds(value, /ms$/.test(keyName));
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?$/.exec(s);
  if (clock) return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? normaliseSeconds(n, /ms$/.test(keyName)) : undefined;
}

function normaliseSeconds(n: number, isMs: boolean): number | undefined {
  if (!(n > 0)) return undefined;
  // Files disagree on the unit; nobody has a ten thousand second track.
  const seconds = isMs || n >= 10_000 ? n / 1000 : n;
  return seconds > 0 && seconds < 36_000 ? Math.round(seconds * 10) / 10 : undefined;
}

/** Turn one record (a CSV row or JSON object) into a wanted track, or null if it has no title. */
export function recordToItem(fields: Map<string, unknown>): ParsedItem | null {
  const title = clip(pick(TITLE_KEYS, fields));
  if (!title) return null;
  const artistValue = pick(ARTIST_KEYS, fields);
  let artists: string[] = [];
  if (Array.isArray(artistValue)) {
    artists = artistValue.map((a) => (typeof a === "string" ? a : clip((a as { name?: unknown })?.name))).map((a) => a.trim()).filter(Boolean);
  } else if (artistValue && typeof artistValue === "object") {
    artists = [clip((artistValue as { name?: unknown }).name)].filter(Boolean);
  } else {
    // "A; B" or "A, B" are several artists; names such as "Simon & Garfunkel" stay whole (the matcher handles both).
    artists = clip(artistValue).split(/\s*;\s*/).filter(Boolean);
  }
  const album = clip(pick(ALBUM_KEYS, fields)) || undefined;
  let durationSec: number | undefined;
  for (const k of DURATION_KEYS) {
    if (fields.has(k)) {
      durationSec = parseDuration(fields.get(k), k);
      if (durationSec !== undefined) break;
    }
  }
  return { title, artists: artists.slice(0, 10), album, durationSec };
}

export function parseCsv(text: string): { items: ParsedItem[]; warnings: string[] } {
  const rows = parseDelimited(text);
  const warnings: string[] = [];
  if (rows.length < 2) return { items: [], warnings: ["The file has no rows."] };
  const header = rows[0].map(key);
  if (!header.some((h) => TITLE_KEYS.includes(h))) {
    return { items: [], warnings: ["No title column was found. The first row should name the columns, for example Title, Artist, Album."] };
  }
  const items: ParsedItem[] = [];
  for (const row of rows.slice(1)) {
    const fields = new Map<string, unknown>();
    header.forEach((h, i) => {
      if (h && !fields.has(h)) fields.set(h, row[i]?.trim() ?? "");
    });
    const item = recordToItem(fields);
    if (item) items.push(item);
  }
  if (items.length === 0) warnings.push("No tracks were found in the rows.");
  return { items, warnings };
}

export function parseJson(text: string): { name?: string; items: ParsedItem[]; warnings: string[] } {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return { items: [], warnings: ["That is not valid JSON."] };
  }
  let name: string | undefined;
  let list: unknown[] | undefined;
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (typeof obj.name === "string") name = clip(obj.name);
    list = ["tracks", "items", "plays", "songs", "data"].map((k) => obj[k]).find(Array.isArray) as unknown[] | undefined;
    if (!list) list = Object.values(obj).find(Array.isArray) as unknown[] | undefined;
  }
  if (!list) return { items: [], warnings: ["No list of tracks was found in the JSON."] };
  const items: ParsedItem[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    let record = entry as Record<string, unknown>;
    // Spotify playlist exports wrap each entry as { track: { name, artists: [...] } }.
    if (record.track && typeof record.track === "object") record = record.track as Record<string, unknown>;
    const fields = new Map<string, unknown>();
    for (const [k, v] of Object.entries(record)) if (!fields.has(key(k))) fields.set(key(k), v);
    const item = recordToItem(fields);
    if (item) items.push(item);
  }
  return { name, items, warnings: items.length ? [] : ["No tracks were found in the JSON."] };
}

/** Merge repeats of the same song and count them; history-like files (scrobbles) are then ranked by plays. */
export function collapseDuplicates(items: ParsedItem[], keyOf: (w: Wanted) => string): ParsedItem[] {
  const seen = new Map<string, ParsedItem>();
  for (const item of items) {
    const k = keyOf(item);
    const existing = seen.get(k);
    if (existing) {
      existing.count = (existing.count ?? 1) + (item.count ?? 1);
      existing.album ??= item.album;
      existing.durationSec ??= item.durationSec;
    } else seen.set(k, { ...item, count: item.count ?? 1 });
  }
  const merged = [...seen.values()];
  if (merged.some((m) => (m.count ?? 1) > 1)) merged.sort((a, b) => (b.count ?? 1) - (a.count ?? 1));
  return merged;
}

