import type { Track } from "@/shared/types";

export interface Album {
  key: string;
  title: string;
  artist: string;
  artwork?: string;
  tracks: Track[];
}

export type AlbumSort = "title" | "artist" | "size";

const SINGLES = "Singles";
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const sortKey = (s: string) => norm(s).replace(/^(the|a|an) /, "");

/**
 * Group tracks into albums. An album is a title plus its first artist, so two bands that both
 * released "Greatest Hits" stay apart; tracks without an album go to "Singles" under their artist.
 */
export function groupAlbums(tracks: Track[]): Album[] {
  const albums = new Map<string, Album>();
  for (const t of tracks) {
    const artist = t.artists[0]?.name?.trim() || "Unknown artist";
    const title = t.album?.trim() || SINGLES;
    const key = `${norm(title)}\u0000${norm(artist)}`;
    const existing = albums.get(key);
    if (existing) {
      if (!existing.tracks.some((x) => x.id === t.id)) existing.tracks.push(t);
      existing.artwork = existing.artwork ?? t.artwork;
    } else {
      albums.set(key, { key, title, artist, artwork: t.artwork, tracks: [t] });
    }
  }
  return [...albums.values()];
}

export function sortAlbums(albums: Album[], by: AlbumSort): Album[] {
  const byTitle = (a: Album, b: Album) => sortKey(a.title).localeCompare(sortKey(b.title)) || sortKey(a.artist).localeCompare(sortKey(b.artist));
  const copy = [...albums];
  if (by === "artist") return copy.sort((a, b) => sortKey(a.artist).localeCompare(sortKey(b.artist)) || byTitle(a, b));
  if (by === "size") return copy.sort((a, b) => b.tracks.length - a.tracks.length || byTitle(a, b));
  return copy.sort(byTitle);
}

export function filterAlbums(albums: Album[], query: string): Album[] {
  const needle = norm(query);
  if (!needle) return albums;
  return albums.filter((a) => norm(`${a.title} ${a.artist}`).includes(needle) || a.tracks.some((t) => norm(t.title).includes(needle)));
}

/** Albums to render now; the wall adds more as you scroll so thousands of albums stay smooth. */
export const pageOf = <T>(items: T[], pages: number, pageSize = 60): T[] => items.slice(0, pages * pageSize);

/** Delay for the gentle fade-in, capped so late items don't wait. */
export const staggerMs = (index: number, step = 30, max = 360): number => Math.min(max, (index % 12) * step);