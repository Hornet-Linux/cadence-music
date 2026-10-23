/** Shapes the streaming server plugins answer with (see apps/server/src/community/_streaming/types.ts). */

export interface StreamTrack {
  id: string;
  title: string;
  artists: string[];
  album?: string;
  artwork?: string;
  durationSec?: number;
  url?: string;
  playback: "preview" | "widget" | "iframe" | "link";
  note?: string;
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
  configured: boolean;
  connected: boolean;
  hasLogin: boolean;
  loginError?: string;
  features: { search: boolean; library: boolean; playlists: boolean; playback: "preview" | "widget" | "iframe" | "link" };
}

export interface AdminConfigField {
  key: string;
  label: string;
  hint?: string;
  secret: boolean;
  optional: boolean;
  set: boolean;
  value?: string;
}

export interface AdminConfig {
  configured: boolean;
  redirectUri?: string;
  fields: AdminConfigField[];
}

/** What the page and settings panel need to know about a service that is not in the server's answers. */
export interface ServiceInfo {
  slug: string;
  name: string;
  /** Prefix for Cadence track ids: "deezer:123". */
  prefix: string;
  /** Where "Powered by" and "Open in" links go. */
  homepage: string;
  /** Short plain-language statement of what works and what does not. */
  capabilities: { works: string[]; limits: string[] };
  /** Required credit line(s) shown on every screen that shows the service's content. */
  credit: { text: string; href: string };
  /** Extra text for the admin about where to get credentials. */
  adminHelp: string;
  /** Link to the service's own terms. */
  termsHref: string;
}
