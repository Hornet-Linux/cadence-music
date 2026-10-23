import type { Track } from "@/shared/types";

export type OverlayTheme = "calm" | "light" | "minimal" | "bar";

export interface OverlayOptions {
  theme: OverlayTheme;
  showArt: boolean;
  showProgress: boolean;
  align: "left" | "right";
  /** 0.5 to 3. */
  scale: number;
}

export const DEFAULT_OVERLAY_OPTIONS: OverlayOptions = {
  theme: "calm",
  showArt: true,
  showProgress: true,
  align: "left",
  scale: 1,
};

export interface ObsSettings {
  /** Send what is playing to the server so overlay links can show it. */
  sendNowPlaying: boolean;
  options: OverlayOptions;
  /** Links created on this device, so their address can be copied again (the server keeps only a hash). */
  links: { id: number; token: string }[];
}

export const DEFAULT_OBS_SETTINGS: ObsSettings = { sendNowPlaying: true, options: DEFAULT_OVERLAY_OPTIONS, links: [] };

/** The address to paste into an OBS Browser Source. Only non-default options are added. */
export function overlayUrl(serverUrl: string, token: string, options: OverlayOptions): string {
  const url = new URL(`overlay/${encodeURIComponent(token)}`, serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`);
  if (options.theme !== "calm") url.searchParams.set("theme", options.theme);
  if (!options.showArt) url.searchParams.set("art", "0");
  if (!options.showProgress) url.searchParams.set("progress", "0");
  if (options.align === "right") url.searchParams.set("align", "right");
  if (options.scale !== 1) url.searchParams.set("scale", String(Math.min(3, Math.max(0.5, options.scale))));
  return url.toString();
}

export interface PlayerSnapshot {
  current: Track | null;
  isPlaying: boolean;
  position: number;
  duration: number;
}

export interface HeartbeatBody {
  state: "playing" | "paused" | "stopped";
  track?: { id: string; title: string; artists: { name: string }[]; album?: string; artwork?: string };
  positionSec?: number;
  durationSec?: number;
}

/** What to tell the server right now. Only the fields the overlay shows are sent. */
export function buildHeartbeat(s: PlayerSnapshot): HeartbeatBody {
  if (!s.current) return { state: "stopped" };
  const t = s.current;
  return {
    state: s.isPlaying ? "playing" : "paused",
    track: {
      id: t.id,
      title: t.title,
      artists: t.artists.map((a) => ({ name: a.name })),
      album: t.album,
      artwork: t.artwork,
    },
    positionSec: Math.round(s.position * 10) / 10,
    durationSec: Math.round((s.duration || t.durationSec || 0) * 10) / 10,
  };
}