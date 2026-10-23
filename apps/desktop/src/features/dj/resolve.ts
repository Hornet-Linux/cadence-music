import type { Track } from "@/shared/types";
import { spotifyFetch } from "@/plugins/builtins/spotify/api";
import { toTrack, type SavedTrackItem } from "@/plugins/builtins/spotify/spotifyStore";
import type { DjPick } from "./prompt";

export interface DjTrack {
  track: Track;
  intro: string;
}

type Fetch = <T>(route: string) => Promise<T>;

/** Lowercase, strip accents, punctuation and "(Remastered 2011)"-style suffixes. */
export function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s*[([].*?[)\]]/g, "")
    .replace(/\s+-\s+.*$/, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Is this track the song the model named? Tolerates remaster suffixes, accents and "feat." differences. */
export function trackMatchesPick(track: Track, pick: { artist: string; title: string }): boolean {
  const title = normalize(track.title);
  const want = normalize(pick.title);
  const titleOk = title === want || title.startsWith(want) || want.startsWith(title);
  const artist = normalize(pick.artist);
  const artistOk = track.artists.some((a) => {
    const n = normalize(a.name);
    return n === artist || n.includes(artist) || artist.includes(n);
  });
  return titleOk && artistOk;
}

async function search(get: Fetch, q: string): Promise<Track[]> {
  const res = await get<{ tracks?: { items: SavedTrackItem["track"][] } }>(
    `search?type=track&limit=5&q=${encodeURIComponent(q)}`,
  );
  return (res.tracks?.items ?? []).map((track) => toTrack({ track })).filter((t): t is Track => !!t);
}

/** Find the real Spotify track for a pick, or null if the model made it up. */
export async function resolvePick(pick: DjPick, get: Fetch = spotifyFetch): Promise<Track | null> {
  const strict = await search(get, `track:${pick.title} artist:${pick.artist}`).catch(() => []);
  const hit = strict.find((t) => trackMatchesPick(t, pick));
  if (hit) return hit;
  // Field filters miss on small spelling differences; a loose search catches those.
  const loose = await search(get, `${pick.artist} ${pick.title}`).catch(() => []);
  return loose.find((t) => trackMatchesPick(t, pick)) ?? null;
}

/**
 * Look up every pick, dropping songs that don't exist, duplicates, and
 * anything already played (`avoidIds` holds Spotify URIs).
 */
export async function resolvePicks(
  picks: DjPick[],
  avoidIds: Iterable<string> = [],
  get: Fetch = spotifyFetch,
): Promise<DjTrack[]> {
  const found = await Promise.all(picks.map((p) => resolvePick(p, get)));
  const seen = new Set(avoidIds);
  const out: DjTrack[] = [];
  found.forEach((track, i) => {
    if (!track || seen.has(track.id)) return;
    seen.add(track.id);
    out.push({ track, intro: picks[i].intro });
  });
  return out;
}
