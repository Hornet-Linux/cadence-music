/**
 * The relay behind "control another Cadence player". Every open player registers as a device for its owner;
 * commands sent to a device are pushed to its connection and the device reports its playback state back.
 * Everything is keyed by user id, so one person can never see or command another person's devices.
 */
export interface HubTrack {
  id: string;
  title: string;
  artists: { id: string; name: string }[];
  album?: string;
  artwork?: string;
  durationSec?: number;
  source?: string;
}

export interface DeviceState {
  track: HubTrack | null;
  isPlaying: boolean;
  position: number;
  duration: number;
  volume: number;
  queue: HubTrack[];
  index: number;
  updatedAt: number;
}

export interface DeviceInfo {
  id: string;
  name: string;
  kind: string;
  online: boolean;
  lastSeen: number;
  state: DeviceState | null;
}

export type HubCommand =
  | { type: "play" | "pause" | "toggle" | "next" | "previous" }
  | { type: "seek"; position: number }
  | { type: "volume"; volume: number }
  | { type: "queue.play"; tracks: HubTrack[]; index: number; position?: number; play?: boolean }
  | { type: "queue.add"; track: HubTrack }
  | { type: "queue.jump"; index: number };

export interface HubConnection {
  /** Push one server-sent event to the device. */
  send(event: string, data: unknown): void;
  /** End the stream. */
  close(): void;
}

export interface StateEvent {
  userId: number;
  device: DeviceInfo;
}

const MAX_QUEUE = 200;

const clip = (s: unknown, max: number): string => (typeof s === "string" ? s.slice(0, max) : "");

/** Reduce a client-supplied track to the fields the relay carries (bounded, no surprises). */
export function cleanTrack(raw: unknown): HubTrack | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const id = clip(t["id"], 400);
  const title = clip(t["title"], 300);
  if (!id || !title) return null;
  const artists = Array.isArray(t["artists"])
    ? (t["artists"] as unknown[]).slice(0, 8).flatMap((a) => {
        const o = a as Record<string, unknown> | null;
        return o && typeof o["name"] === "string" ? [{ id: clip(o["id"], 200) || clip(o["name"], 200), name: clip(o["name"], 200) }] : [];
      })
    : [];
  const out: HubTrack = { id, title, artists };
  if (typeof t["album"] === "string") out.album = clip(t["album"], 300);
  if (typeof t["artwork"] === "string" && /^https?:\/\//i.test(t["artwork"])) out.artwork = clip(t["artwork"], 600);
  if (typeof t["durationSec"] === "number" && Number.isFinite(t["durationSec"])) out.durationSec = t["durationSec"];
  if (typeof t["source"] === "string") out.source = clip(t["source"], 40);
  return out;
}

export function cleanState(raw: unknown, now = Date.now()): DeviceState | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const queue = Array.isArray(s["queue"]) ? (s["queue"] as unknown[]).slice(0, MAX_QUEUE).map(cleanTrack).filter((t): t is HubTrack => t !== null) : [];
  return {
    track: cleanTrack(s["track"]),
    isPlaying: s["isPlaying"] === true,
    position: Math.max(0, num(s["position"], 0)),
    duration: Math.max(0, num(s["duration"], 0)),
    volume: Math.min(1, Math.max(0, num(s["volume"], 1))),
    queue,
    index: Math.floor(num(s["index"], -1)),
    updatedAt: now,
  };
}

/** Check a command from a controller. Returns null for anything that is not a known, well-formed command. */
export function cleanCommand(raw: unknown): HubCommand | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  switch (c["type"]) {
    case "play":
    case "pause":
    case "toggle":
    case "next":
    case "previous":
      return { type: c["type"] };
    case "seek":
      return finite(c["position"]) && c["position"] >= 0 ? { type: "seek", position: c["position"] } : null;
    case "volume":
      return finite(c["volume"]) ? { type: "volume", volume: Math.min(1, Math.max(0, c["volume"])) } : null;
    case "queue.jump":
      return finite(c["index"]) && c["index"] >= 0 ? { type: "queue.jump", index: Math.floor(c["index"]) } : null;
    case "queue.add": {
      const track = cleanTrack(c["track"]);
      return track ? { type: "queue.add", track } : null;
    }
    case "queue.play": {
      const tracks = Array.isArray(c["tracks"]) ? (c["tracks"] as unknown[]).slice(0, MAX_QUEUE).map(cleanTrack).filter((t): t is HubTrack => t !== null) : [];
      if (tracks.length === 0) return null;
      const index = finite(c["index"]) ? Math.min(tracks.length - 1, Math.max(0, Math.floor(c["index"]))) : 0;
      return {
        type: "queue.play",
        tracks,
        index,
        position: finite(c["position"]) && c["position"] >= 0 ? c["position"] : undefined,
        play: c["play"] !== false,
      };
    }
    default:
      return null;
  }
}
