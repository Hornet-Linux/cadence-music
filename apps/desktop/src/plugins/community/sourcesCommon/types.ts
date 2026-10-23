import type { Track } from "@/shared/types";

/** An album, artist or playlist shown as a card, with its cover already pointing at the server. */
export interface Card {
  id: string;
  name: string;
  subtitle?: string;
  artwork?: string;
}

export interface TrackPage {
  items: Track[];
  total: number;
  hasMore: boolean;
}

export interface CardPage {
  items: Card[];
  total: number;
  hasMore: boolean;
}

/** The server's page shape (see the Subsonic and Plex server plugins). */
export interface ServerPage<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

export interface TrackQuery {
  q?: string;
  albumId?: string;
  favourites?: boolean;
  limit?: number;
  offset?: number;
}

export interface AlbumQuery {
  q?: string;
  artistId?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

/** What a music-source page needs from its store. */
export interface BrowseApi {
  /** "Subsonic", "Plex": used in labels. */
  label: string;
  listTracks: (query: TrackQuery) => Promise<TrackPage>;
  listAlbums: (query: AlbumQuery) => Promise<CardPage>;
  listArtists: (query: { q?: string; limit?: number; offset?: number }) => Promise<CardPage>;
  albumTracks: (albumId: string) => Promise<Track[]>;
  listPlaylists: () => Promise<Card[]>;
  playlistTracks: (playlistId: string) => Promise<Track[]>;
  /** React hook: is this track a favourite? */
  useIsFavourite: (track: Track) => boolean;
  toggleFavourite: (track: Track) => Promise<void>;
}

export function search(params: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "" || value === false) continue;
    qs.set(key, value === true ? "1" : String(value));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

export const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));