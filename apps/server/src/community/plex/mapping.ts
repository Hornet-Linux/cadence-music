import type { PlexAlbum, PlexArtist, PlexPlaylist, PlexTrack } from "./types.js";
import { idOf } from "./client.js";
import { int, text } from "../sourcesCommon/util.js";

export interface PxPart {
  key?: unknown;
}
export interface PxMedia {
  container?: unknown;
  audioCodec?: unknown;
  Part?: PxPart[];
}

/** The parts of Plex metadata that Cadence reads. Everything is optional: it is untrusted input. */
export interface PxItem {
  ratingKey?: unknown;
  type?: unknown;
  title?: unknown;
  originalTitle?: unknown;
  grandparentTitle?: unknown;
  grandparentRatingKey?: unknown;
  parentTitle?: unknown;
  parentRatingKey?: unknown;
  parentYear?: unknown;
  index?: unknown;
  duration?: unknown;
  year?: unknown;
  thumb?: unknown;
  parentThumb?: unknown;
  grandparentThumb?: unknown;
  userRating?: unknown;
  viewCount?: unknown;
  leafCount?: unknown;
  childCount?: unknown;
  Media?: PxMedia[];
}

/** Turns a Plex item id (whose picture it is) into a signed relative image path. */
export type ArtworkFn = (itemId: string) => string;

/** Plex sends picture paths like /library/metadata/42/thumb/1700000000; the id in the middle is what identifies the picture. */
const THUMB_RE = /^\/library\/metadata\/(\d{1,12})\/thumb(?:\/\d+)?$/;

export function thumbId(value: unknown): string | undefined {
  return typeof value === "string" ? THUMB_RE.exec(value)?.[1] : undefined;
}

/** Favourites are ratings of 8 and up (four stars of five, or a Plexamp heart). */
export const FAVOURITE_RATING = 8;

export function toTrack(item: PxItem, art: ArtworkFn): PlexTrack | null {
  const id = idOf(item.ratingKey);
  const title = text(item.title);
  if (!id || !title) return null;
  const artist = text(item.originalTitle, 200) ?? text(item.grandparentTitle, 200);
  const track: PlexTrack = { id, title, artists: artist ? [artist] : [] };
  const album = text(item.parentTitle, 300);
  if (album) track.album = album;
  const albumId = idOf(item.parentRatingKey);
  if (albumId) track.albumId = albumId;
  const artistId = idOf(item.grandparentRatingKey);
  if (artistId) track.artistId = artistId;
  if (typeof item.duration === "number" && item.duration > 0) track.durationSec = Math.round(item.duration) / 1000;
  const trackNo = int(item.index);
  if (trackNo !== undefined) track.trackNo = trackNo;
  const year = int(item.year) ?? int(item.parentYear);
  if (year) track.year = year;
  // The album's picture first: tracks of one album then share one cached image.
  const pic = thumbId(item.parentThumb) ?? thumbId(item.thumb) ?? thumbId(item.grandparentThumb);
  if (pic) track.artwork = art(pic);
  track.favourite = typeof item.userRating === "number" && item.userRating >= FAVOURITE_RATING;
  const plays = int(item.viewCount);
  if (plays !== undefined) track.playCount = plays;
  return track;
}

export function toAlbum(item: PxItem, art: ArtworkFn): PlexAlbum | null {
  const id = idOf(item.ratingKey);
  const name = text(item.title);
  if (!id || !name) return null;
  const album: PlexAlbum = { id, name };
  const artist = text(item.parentTitle, 200);
  if (artist) album.artist = artist;
  const artistId = idOf(item.parentRatingKey);
  if (artistId) album.artistId = artistId;
  const year = int(item.year);
  if (year) album.year = year;
  const count = int(item.leafCount);
  if (count !== undefined) album.trackCount = count;
  const pic = thumbId(item.thumb);
  if (pic) album.artwork = art(pic);
  return album;
}

export function toArtist(item: PxItem, art: ArtworkFn): PlexArtist | null {
  const id = idOf(item.ratingKey);
  const name = text(item.title, 200);
  if (!id || !name) return null;
  const artist: PlexArtist = { id, name };
  const count = int(item.childCount);
  if (count !== undefined) artist.albumCount = count;
  const pic = thumbId(item.thumb);
  if (pic) artist.artwork = art(pic);
  return artist;
}

export function toPlaylist(item: PxItem): PlexPlaylist | null {
  const id = idOf(item.ratingKey);
  const name = text(item.title);
  if (!id || !name) return null;
  return { id, name, trackCount: int(item.leafCount) ?? 0 };
}

/** What a player needs to start a track: where the original file is, and whether browsers can play it. */
export interface StreamInfo {
  mode: "direct" | "transcode";
  /** The part key (for example /library/parts/12/1700000000/file.flac). */
  partKey: string;
}

const PART_RE = /^\/library\/parts\/\d{1,12}(?:\/\d{1,12})?\/[\w.-]{1,200}$/;
const DIRECT_CONTAINERS = new Set(["mp3", "flac", "wav", "aac", "mp4", "m4a", "m4b"]);
const DIRECT_CODECS = new Set(["mp3", "aac", "flac", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_u8"]);

export function streamInfo(item: PxItem): StreamInfo | null {
  const media = item.Media?.[0];
  const key = media?.Part?.[0]?.key;
  if (typeof key !== "string" || !PART_RE.test(key)) return null;
  const container = typeof media?.container === "string" ? media.container.toLowerCase() : "";
  const codec = typeof media?.audioCodec === "string" ? media.audioCodec.toLowerCase() : "";
  return { mode: DIRECT_CONTAINERS.has(container) && DIRECT_CODECS.has(codec) ? "direct" : "transcode", partKey: key };
}