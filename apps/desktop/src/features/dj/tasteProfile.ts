import { primaryArtist, type Track } from "@/shared/types";
import { spotifyFetch } from "@/plugins/builtins/spotify/api";
import { toTrack, type SavedTrackItem } from "@/plugins/builtins/spotify/spotifyStore";

/** What the DJ knows about the listener. Kept small so it fits a local model's context. */
export interface TasteProfile {
  topArtists: string[];
  genres: string[];
  /** "Artist – Title" lines. */
  topTracks: string[];
  recentTracks: string[];
}

interface TopArtist {
  name: string;
  genres?: string[];
}

type Fetch = <T>(route: string) => Promise<T>;

const line = (t: Track) => `${primaryArtist(t)} – ${t.title}`;

function uniq(values: string[], max: number): string[] {
  return [...new Set(values.filter(Boolean))].slice(0, max);
}

/** Most common genres first. */
function rankGenres(artists: TopArtist[], max: number): string[] {
  const counts = new Map<string, number>();
  for (const a of artists) for (const g of a.genres ?? []) counts.set(g, (counts.get(g) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g).slice(0, max);
}

/**
 * Build a profile from Spotify listening history. Each source is optional:
 * sessions from before the top/recent scopes were added get a 403, and then
 * we fall back to the liked songs already loaded in the library.
 */
export async function buildTasteProfile(liked: Track[], get: Fetch = spotifyFetch): Promise<TasteProfile> {
  const safe = <T>(route: string) => get<T>(route).catch(() => null);
  const [artists, tracks, recent] = await Promise.all([
    safe<{ items: TopArtist[] }>("me/top/artists?time_range=medium_term&limit=20"),
    safe<{ items: SavedTrackItem["track"][] }>("me/top/tracks?time_range=short_term&limit=20"),
    safe<{ items: SavedTrackItem[] }>("me/player/recently-played?limit=30"),
  ]);

  const topTracks = (tracks?.items ?? []).map((track) => toTrack({ track })).filter((t): t is Track => !!t);
  const recentTracks = (recent?.items ?? []).map(toTrack).filter((t): t is Track => !!t);
  const topArtistNames = (artists?.items ?? []).map((a) => a.name);

  // Liked songs fill in whatever history didn't give us.
  const likedSample = liked.slice(0, 40);
  return {
    topArtists: uniq([...topArtistNames, ...likedSample.map(primaryArtist)], 20),
    genres: rankGenres(artists?.items ?? [], 8),
    topTracks: uniq([...topTracks, ...likedSample].map(line), 20),
    recentTracks: uniq(recentTracks.map(line), 15),
  };
}

export function isEmptyProfile(p: TasteProfile): boolean {
  return p.topArtists.length === 0 && p.topTracks.length === 0 && p.recentTracks.length === 0;
}
