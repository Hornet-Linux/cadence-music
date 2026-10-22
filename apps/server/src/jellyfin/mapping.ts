import type { JellyfinAlbum, JellyfinPlaylist, JellyfinTrack } from "@uma/shared";
import { ticksToSec, validId } from "./client.js";

/** The parts of Jellyfin's BaseItemDto that Cadence reads. Everything is optional: it is untrusted input. */
export interface JfItem {
  Id?: string;
  Name?: string;
  Artists?: string[];
  AlbumArtist?: string;
  Album?: string;
  AlbumId?: string;
  AlbumPrimaryImageTag?: string;
  RunTimeTicks?: number;
  IndexNumber?: number;
  ProductionYear?: number;
  ChildCount?: number;
  Genres?: string[];
  ImageTags?: { Primary?: string };
  UserData?: { IsFavorite?: boolean; PlayCount?: number };
}

export interface JfItemsResponse {
  Items?: JfItem[];
  TotalRecordCount?: number;
}

/** Turns a Jellyfin item id into a signed relative image path. */
export type ArtworkFn = (itemId: string) => string;

const text = (v: unknown, max = 500): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);

/** A track's own picture if it has one, otherwise its album's. */
function artworkFor(item: JfItem, art: ArtworkFn): string | undefined {
  if (item.ImageTags?.Primary && validId(item.Id)) return art(item.Id.toLowerCase());
  if (item.AlbumPrimaryImageTag && validId(item.AlbumId)) return art(item.AlbumId.toLowerCase());
  return undefined;
}

export function toTrack(item: JfItem, art: ArtworkFn): JellyfinTrack | null {
  if (!validId(item.Id)) return null;
  const title = text(item.Name);
  if (!title) return null;
  const artists = (Array.isArray(item.Artists) ? item.Artists : []).map((a) => text(a, 200)).filter((a): a is string => !!a);
  const albumArtist = text(item.AlbumArtist, 200);
  const track: JellyfinTrack = { id: item.Id.toLowerCase(), title, artists: artists.length ? artists : albumArtist ? [albumArtist] : [] };
  const album = text(item.Album, 300);
  if (album) track.album = album;
  if (validId(item.AlbumId)) track.albumId = item.AlbumId.toLowerCase();
  const duration = ticksToSec(item.RunTimeTicks);
  if (duration !== undefined) track.durationSec = duration;
  const trackNo = int(item.IndexNumber);
  if (trackNo !== undefined) track.trackNo = trackNo;
  const year = int(item.ProductionYear);
  if (year) track.year = year;
  const artwork = artworkFor(item, art);
  if (artwork) track.artwork = artwork;
  if (item.UserData) track.favourite = item.UserData.IsFavorite === true;
  return track;
}

export function toAlbum(item: JfItem, art: ArtworkFn): JellyfinAlbum | null {
  if (!validId(item.Id)) return null;
  const name = text(item.Name);
  if (!name) return null;
  const album: JellyfinAlbum = { id: item.Id.toLowerCase(), name };
  const artist = text(item.AlbumArtist, 200) ?? text(item.Artists?.[0], 200);
  if (artist) album.artist = artist;
  const year = int(item.ProductionYear);
  if (year) album.year = year;
  const count = int(item.ChildCount);
  if (count !== undefined) album.trackCount = count;
  if (item.ImageTags?.Primary) album.artwork = art(album.id);
  return album;
}

export function toPlaylist(item: JfItem, art: ArtworkFn): JellyfinPlaylist | null {
  if (!validId(item.Id)) return null;
  const name = text(item.Name);
  if (!name) return null;
  const playlist: JellyfinPlaylist = { id: item.Id.toLowerCase(), name, trackCount: int(item.ChildCount) ?? 0 };
  if (item.ImageTags?.Primary) playlist.artwork = art(playlist.id);
  return playlist;
}

/** "Artist – Title", the line format the AI DJ's taste profile uses. */
export function line(track: JellyfinTrack): string {
  const artist = track.artists[0];
  return (artist ? `${artist} – ${track.title}` : track.title).slice(0, 200);
}
