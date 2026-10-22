import type { Lyrics, LyricsProvider } from "../../types";
import type { Track } from "@/shared/types";
import type { PersistentCache } from "../lyrics-view/cache";
import { instrumentalLyrics, parseLrc, plainLines } from "../lyrics-view/lrc";

export const LRCLIB_BASE = "https://lrclib.net/api";
export const LRCLIB_SOURCE = "LRCLIB";
/**
 * LRCLIB asks clients to identify themselves. Browsers do not let a page set User-Agent, and
 * sending it would fail the CORS preflight, so the documented Lrclib-Client header is used.
 */
export const LRCLIB_CLIENT = "Cadence Music Player (https://github.com/Hornet-Linux/cadence-music)";

/** The parts of an LRCLIB record this plugin reads. */
export interface LrclibRecord {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string | null;
  duration?: number | null;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

export interface LookupOptions {
  /** Skip the cache and ask LRCLIB again. */
  fresh?: boolean;
}

export type LrclibProvider = Omit<LyricsProvider, "getLyrics"> & {
  getLyrics: (track: Track, signal?: AbortSignal, options?: LookupOptions) => Promise<Lyrics | null>;
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Song (feat. X) - 2011 Remaster becomes Song. Used for the looser second search. */
export function cleanTitle(title: string): string {
  return title
    .replace(/\s*[([][^)\]]*(feat|ft\.|with|remaster|live|version|edit|mix|mono|stereo)[^)\]]*[)\]]/gi, "")
    .replace(/\s+-\s+(\d{4}\s+)?(remaster(ed)?|live|mono|stereo|single version|radio edit).*$/i, "")
    .trim();
}

/** Turn an LRCLIB record into Lyrics. Null when the record has no words. */
export function recordToLyrics(record: LrclibRecord): Lyrics | null {
  if (record.instrumental) return instrumentalLyrics(LRCLIB_SOURCE);
  if (record.syncedLyrics?.trim()) {
    const parsed = parseLrc(record.syncedLyrics);
    if (parsed.synced && parsed.lines.some((l) => l.text)) {
      return { lines: parsed.lines, synced: true, source: LRCLIB_SOURCE };
    }
  }
  if (record.plainLyrics?.trim()) {
    const lines = plainLines(record.plainLyrics);
    if (lines.length) return { lines, synced: false, source: LRCLIB_SOURCE };
  }
  return null;
}

/**
 * The best search hit for a track: the title must match, the length must be close when both
 * are known, and synced lyrics beat plain ones.
 */
export function pickBest(records: LrclibRecord[], track: Track): LrclibRecord | null {
  const title = norm(track.title);
  const cleaned = norm(cleanTitle(track.title));
  const artist = norm(track.artists[0]?.name ?? "");
  let best: { record: LrclibRecord; score: number } | null = null;
  for (const r of records) {
    const rt = norm(r.trackName ?? "");
    if (!rt || !(rt === title || rt === cleaned || norm(cleanTitle(r.trackName ?? "")) === cleaned)) continue;
    const hasWords = r.instrumental || r.syncedLyrics?.trim() || r.plainLyrics?.trim();
    if (!hasWords) continue;
    let score = 0;
    if (r.syncedLyrics?.trim()) score += 4;
    if (r.instrumental) score += 1;
    const ra = norm(r.artistName ?? "");
    if (artist && ra) {
      if (ra === artist) score += 6;
      else if (ra.includes(artist) || artist.includes(ra)) score += 3;
      else continue; // A different artist's song with the same name.
    }
    if (track.durationSec && r.duration) {
      const diff = Math.abs(r.duration - track.durationSec);
      if (diff > 5) continue;
      score += diff <= 2 ? 3 : 1;
    }
    if (!best || score > best.score) best = { record: r, score };
  }
  return best?.record ?? null;
}

export interface LrclibDeps {
  fetch: typeof fetch;
  cache: PersistentCache<Lyrics>;
  base?: string;
}

/** Look lyrics up on LRCLIB: an exact get, then a search. Results (and misses) are cached. */
export function createLrclibProvider(deps: LrclibDeps): LrclibProvider {
  const base = deps.base ?? LRCLIB_BASE;
  const inflight = new Map<string, Promise<Lyrics | null>>();

  async function getJson<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T | null> {
    const url = `${base}${path}?${new URLSearchParams(params).toString()}`;
    const res = await deps.fetch(url, { signal, headers: { "Lrclib-Client": LRCLIB_CLIENT } });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(res.status === 429 ? "LRCLIB is busy, try again in a minute" : `LRCLIB answered ${res.status}`);
    }
    return (await res.json()) as T;
  }

  async function lookup(track: Track, signal?: AbortSignal): Promise<Lyrics | null> {
    const title = track.title.trim();
    const artist = track.artists[0]?.name?.trim() ?? "";
    if (!title) return null;

    // 1. Exact match by artist, title, album and length.
    if (artist) {
      const params: Record<string, string> = { track_name: title, artist_name: artist };
      if (track.album) params.album_name = track.album;
      if (track.durationSec) params.duration = String(Math.round(track.durationSec));
      const exact = await getJson<LrclibRecord>("/get", params, signal);
      const lyrics = exact ? recordToLyrics(exact) : null;
      if (lyrics) return lyrics;
    }

    // 2. Search, then choose the closest hit.
    const query: Record<string, string> = artist
      ? { track_name: cleanTitle(title) || title, artist_name: artist }
      : { q: cleanTitle(title) || title };
    const hits = await getJson<LrclibRecord[]>("/search", query, signal);
    if (Array.isArray(hits)) {
      const best = pickBest(hits, track);
      const lyrics = best ? recordToLyrics(best) : null;
      if (lyrics) return lyrics;
    }
    return null;
  }

  return {
    id: "lrclib",
    label: LRCLIB_SOURCE,
    async getLyrics(track, signal, options) {
      const key = [track.artists[0]?.name ?? "", track.title, track.album ?? "", Math.round(track.durationSec ?? 0)]
        .map((p) => norm(String(p)))
        .join("|");
      if (!options?.fresh) {
        const cached = deps.cache.get(key);
        if (cached !== undefined) return cached;
        const pending = inflight.get(key);
        if (pending) return pending;
      }
      const run = lookup(track, signal)
        .then((lyrics) => {
          deps.cache.set(key, lyrics);
          return lyrics;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, run);
      return run;
    },
  };
}
