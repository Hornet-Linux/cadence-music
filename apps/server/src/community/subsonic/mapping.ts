import type { SubsonicAlbum, SubsonicArtist, SubsonicPlaylist, SubsonicTrack } from "./types.js";
import { idOf } from "./client.js";
import { int, text } from "../sourcesCommon/util.js";

/** The parts of Subsonic's Child/AlbumID3/ArtistID3/Playlist objects that Cadence reads. Everything is optional: it is untrusted input. */
export interface SubChild {
  id?: unknown;
  isDir?: boolean;
  title?: unknown;
  name?: unknown;
  artist?: unknown;
  artists?: { name?: unknown }[];
  albumArtist?: unknown;
  album?: unknown;
  albumId?: unknown;
  artistId?: unknown;
  track?: unknown;
  year?: unknown;
  genre?: unknown;
  duration?: unknown;
  coverArt?: unknown;
  starred?: unknown;
  playCount?: unknown;
  songCount?: unknown;
  albumCount?: unknown;
}

/** Turns a Subsonic cover art id into a signed relative image path. */
export type ArtworkFn = (coverArtId: string) => string;

const seconds = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v * 1000) / 1000 : undefined);

export function toTrack(item: SubChild, art: ArtworkFn): SubsonicTrack | null {
  const id = idOf(item.id);
  if (!id || item.isDir === true) return null;
  const title = text(item.title) ?? text(item.name);
  if (!title) return null;
  const fromList = (Array.isArray(item.artists) ? item.artists : []).map((a) => text(a?.name, 200)).filter((a): a is string => !!a);
  const single = text(item.artist, 200) ?? text(item.albumArtist, 200);
  const track: SubsonicTrack = { id, title, artists: fromList.length ? fromList : single ? [single] : [] };
  const album = text(item.album, 300);
  if (album) track.album = album;
  const albumId = idOf(item.albumId);
  if (albumId) track.albumId = albumId;
  const artistId = idOf(item.artistId);
  if (artistId) track.artistId = artistId;
  const duration = seconds(item.duration);
  if (duration !== undefined) track.durationSec = duration;
  const trackNo = int(item.track);
  if (trackNo !== undefined) track.trackNo = trackNo;
  const year = int(item.year);
  if (year) track.year = year;
  const genre = text(item.genre, 100);
  if (genre) track.genre = genre;
  const cover = idOf(item.coverArt) ?? albumId;
  if (cover) track.artwork = art(cover);
  track.favourite = typeof item.starred === "string" && item.starred !== "";
  const plays = int(item.playCount);
  if (plays !== undefined) track.playCount = plays;
  return track;
}

export function toAlbum(item: SubChild, art: ArtworkFn): SubsonicAlbum | null {
  const id = idOf(item.id);
  if (!id) return null;
  const name = text(item.name) ?? text(item.title) ?? text(item.album);
  if (!name) return null;
  const album: SubsonicAlbum = { id, name };
  const artist = text(item.artist, 200);
  if (artist) album.artist = artist;
  const artistId = idOf(item.artistId);
  if (artistId) album.artistId = artistId;
  const year = int(item.year);
  if (year) album.year = year;
  const count = int(item.songCount);
  if (count !== undefined) album.trackCount = count;
  const cover = idOf(item.coverArt);
  if (cover) album.artwork = art(cover);
  if (typeof item.starred === "string" && item.starred !== "") album.favourite = true;
  return album;
}

export function toArtist(item: SubChild, art: ArtworkFn): SubsonicArtist | null {
  const id = idOf(item.id);
  const name = text(item.name, 200);
  if (!id || !name) return null;
  const artist: SubsonicArtist = { id, name };
  const count = int(item.albumCount);
  if (count !== undefined) artist.albumCount = count;
  const cover = idOf(item.coverArt);
  if (cover) artist.artwork = art(cover);
  return artist;
}

export function toPlaylist(item: SubChild, art: ArtworkFn): SubsonicPlaylist | null {
  const id = idOf(item.id);
  const name = text(item.name);
  if (!id || !name) return null;
  const playlist: SubsonicPlaylist = { id, name, trackCount: int(item.songCount) ?? 0 };
  const cover = idOf(item.coverArt);
  if (cover) playlist.artwork = art(cover);
  return playlist;
}

/** Subsonic returns a single object instead of a one-item array on some servers (and XML-derived ones). */
export function list<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  return value && typeof value === "object" ? [value as T] : [];
}