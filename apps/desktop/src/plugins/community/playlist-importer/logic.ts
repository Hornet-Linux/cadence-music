import type { Track } from "@/shared/types";

/** What the server's parser and matcher return (see apps/server/src/community/playlist-importer). */
export interface Wanted {
  title: string;
  artists: string[];
  album?: string;
  durationSec?: number;
  count?: number;
}

export type Confidence = "high" | "medium" | "low" | "none";

export interface MatchCandidate {
  score: number;
  confidence: Confidence;
  source: "server" | "extra";
  id: string;
  track?: Track;
}

/** One line of the preview. */
export interface Row {
  key: number;
  wanted: Wanted;
  candidates: MatchCandidate[];
  /** Index into `candidates`, or "skip", or "original" (keep the track as it came, e.g. a Spotify track), or "manual". */
  choice: number | "skip" | "original" | "manual";
  /** A track the person picked with the search box. */
  manual?: Track;
  /** The imported track itself, when it can be played as it is (Spotify). */
  original?: Track;
}

/** Decode a file's bytes: UTF-8, or UTF-16 when a byte order mark says so (Apple's text exports often are). */
export function decodeText(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  if (view[0] === 0xff && view[1] === 0xfe) return new TextDecoder("utf-16le").decode(view.subarray(2));
  if (view[0] === 0xfe && view[1] === 0xff) return new TextDecoder("utf-16be").decode(view.subarray(2));
  return new TextDecoder("utf-8").decode(view);
}

/** What to pre-select for a row: sure matches are taken, doubtful ones are offered but need a look. */
export function defaultChoice(candidates: MatchCandidate[], original?: Track): Row["choice"] {
  const best = candidates[0];
  if (best && (best.confidence === "high" || best.confidence === "medium")) return 0;
  return original ? "original" : "skip";
}

export function makeRow(key: number, wanted: Wanted, candidates: MatchCandidate[], original?: Track): Row {
  return { key, wanted, candidates, original, choice: defaultChoice(candidates, original) };
}

export type RowStatus = "matched" | "review" | "original" | "missing";

export function statusOf(row: Row): RowStatus {
  if (row.choice === "skip") return "missing";
  if (row.choice === "original") return "original";
  if (row.choice === "manual") return "matched";
  const c = row.candidates[row.choice];
  if (!c) return "missing";
  return c.confidence === "high" ? "matched" : "review";
}

/** The track a row will add, or null. `lookup` finds tracks from other sources by id. */
export function chosenTrack(row: Row, lookup: (id: string) => Track | undefined): Track | null {
  if (row.choice === "skip") return null;
  if (row.choice === "original") return row.original ?? null;
  if (row.choice === "manual") return row.manual ?? null;
  const c = row.candidates[row.choice];
  if (!c) return null;
  return c.track ?? lookup(c.id) ?? null;
}

export function summarize(rows: Row[], lookup: (id: string) => Track | undefined) {
  const out = { total: rows.length, matched: 0, review: 0, original: 0, missing: 0, tracks: [] as Track[] };
  const seen = new Set<string>();
  for (const row of rows) {
    const track = chosenTrack(row, lookup);
    const status = track ? statusOf(row) : "missing";
    out[status] += 1;
    if (track && !seen.has(track.id)) {
      seen.add(track.id);
      out.tracks.push(track);
    }
  }
  return out;
}

const norm = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/** A plain search for the "find another track" box: every word must appear in title, artist or album. */
export function searchTracks(tracks: Track[], query: string, limit = 8): Track[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const hits: Track[] = [];
  for (const t of tracks) {
    const hay = norm(`${t.title} ${t.artists.map((a) => a.name).join(" ")} ${t.album ?? ""}`);
    if (words.every((w) => hay.includes(w))) {
      hits.push(t);
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

/** Spotify's playlist item, reduced to the parts the importer needs. */
export interface SpotifyPlaylistItem {
  track: {
    uri: string;
    name: string;
    duration_ms: number;
    is_local?: boolean;
    artists: { id: string | null; name: string }[];
    album: { name: string; images?: { url: string; width: number | null }[] };
  } | null;
}

export function spotifyItemToRow(item: SpotifyPlaylistItem): { wanted: Wanted; original: Track } | null {
  const t = item.track;
  if (!t || t.is_local || !t.uri?.startsWith("spotify:track:")) return null;
  const artists = t.artists.map((a) => a.name).filter(Boolean);
  const images = t.album.images ?? [];
  return {
    wanted: { title: t.name, artists, album: t.album.name, durationSec: t.duration_ms / 1000 },
    original: {
      id: t.uri,
      title: t.name,
      artists: t.artists.map((a) => ({ id: a.id ?? a.name, name: a.name })),
      album: t.album.name,
      artwork: (images.find((i) => (i.width ?? 0) <= 320) ?? images[0])?.url,
      durationSec: t.duration_ms / 1000,
      source: "spotify",
    },
  };
}

/** Keep only the most played N when the file is a history (items carry counts). */
export function topByPlays<T extends { wanted: Wanted }>(rows: T[], n: number): T[] {
  const hasCounts = rows.some((r) => (r.wanted.count ?? 1) > 1);
  return hasCounts ? rows.slice(0, n) : rows;
}