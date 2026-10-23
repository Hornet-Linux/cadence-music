/** What the Subsonic routes return to Cadence apps. Ids are the Subsonic server's own ids. */
export interface SubsonicTrack {
  id: string;
  title: string;
  artists: string[];
  album?: string;
  albumId?: string;
  artistId?: string;
  durationSec?: number;
  trackNo?: number;
  year?: number;
  genre?: string;
  /** Relative, signed cover art path. */
  artwork?: string;
  favourite?: boolean;
  playCount?: number;
}

export interface SubsonicAlbum {
  id: string;
  name: string;
  artist?: string;
  artistId?: string;
  year?: number;
  trackCount?: number;
  artwork?: string;
  favourite?: boolean;
}

export interface SubsonicArtist {
  id: string;
  name: string;
  albumCount?: number;
  artwork?: string;
}

export interface SubsonicPlaylist {
  id: string;
  name: string;
  trackCount: number;
  artwork?: string;
}

/** `total` is exact when the server can tell; otherwise it is what is known so far and `hasMore` says to keep going. */
export interface Page<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

export interface SubsonicStatus {
  configured: boolean;
  connected: boolean;
  serverName?: string;
  userName?: string;
}

export interface SubsonicStreamUrl {
  path: string;
  expiresAt: number;
}

export interface SubsonicPlaybackReport {
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