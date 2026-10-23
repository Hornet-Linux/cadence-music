/** What the Plex routes return to Cadence apps. Ids are Plex rating keys (digits). */
export interface PlexTrack {
  id: string;
  title: string;
  artists: string[];
  album?: string;
  albumId?: string;
  artistId?: string;
  durationSec?: number;
  trackNo?: number;
  year?: number;
  /** Relative, signed cover art path. */
  artwork?: string;
  favourite?: boolean;
  playCount?: number;
}

export interface PlexAlbum {
  id: string;
  name: string;
  artist?: string;
  artistId?: string;
  year?: number;
  trackCount?: number;
  artwork?: string;
}

export interface PlexArtist {
  id: string;
  name: string;
  albumCount?: number;
  artwork?: string;
}

export interface PlexPlaylist {
  id: string;
  name: string;
  trackCount: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

export interface PlexLibrary {
  key: string;
  title: string;
}

export interface PlexStatus {
  configured: boolean;
  connected: boolean;
  serverName?: string;
  userName?: string;
  /** The music library in use. */
  library?: PlexLibrary;
  /** Signed in, but a music library still has to be chosen. */
  needsLibrary?: boolean;
}

/** Answer to starting a link: the person types `code` at `linkUrl` while signed in to plex.tv. */
export interface PlexPinResponse {
  code: string;
  linkUrl: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export type PlexPinPoll =
  | { state: "waiting"; expiresAt: number }
  | { state: "expired" }
  | { state: "no_access" }
  | { state: "connected"; status: PlexStatus };

export interface PlexStreamUrl {
  path: string;
  expiresAt: number;
  /** "direct" plays the original file; "transcode" asks Plex for MP3. */
  mode: "direct" | "transcode";
}

export interface PlexPlaybackReport {
  event: "start" | "stop";
  itemId: string;
  positionSec: number;
  durationSec?: number;
}

export interface AdminAddress {
  serverUrl: string | null;
  source: "env" | "admin" | null;
}

export interface AdminTestResult {
  ok: boolean;
  error?: string;
  serverName?: string;
  version?: string;
}