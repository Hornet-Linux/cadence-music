/** A track as the streaming plugins hand it to the apps (one shape for every service). */
export interface StreamTrack {
  /** The service's own id, as text. */
  id: string;
  title: string;
  artists: string[];
  album?: string;
  artwork?: string;
  durationSec?: number;
  /** Page for this track on the service (for "Open in ...", and attribution back-links). */
  url?: string;
  /** What Cadence may play: a 30 s preview, or only through the service's own player/link. */
  playback: "preview" | "widget" | "iframe" | "link";
  /** A short note for the listing, e.g. "Preview only". */
  note?: string;
  /** Short-lived preview audio, when the service offers one with the listing. */
  previewUrl?: string;
}

export interface StreamPlaylist {
  id: string;
  name: string;
  artwork?: string;
  trackCount?: number;
  url?: string;
}

export interface StreamStatus {
  service: string;
  name: string;
  /** The server owner has entered the credentials the service needs. */
  configured: boolean;
  /** This person has signed in to the service (always true when no sign-in is needed). */
  connected: boolean;
  /** Whether the service has a personal sign-in at all. */
  hasLogin: boolean;
  /** The last sign-in attempt failed with this (cleared on the next attempt). */
  loginError?: string;
  /** Which things this plugin can do, so the app can say what is missing. */
  features: { search: boolean; library: boolean; playlists: boolean; playback: "preview" | "widget" | "iframe" | "link" };
}
