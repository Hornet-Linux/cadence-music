import { fetchText } from "../_devices/http.js";
import type { DeviceInfo } from "../_devices/hub.js";

export interface HaTarget {
  /** Base URL of Home Assistant, e.g. http://homeassistant.local:8123 (no trailing slash). */
  url: string;
  token: string;
  entityId: string;
}

export const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]{1,80}$/;

/** What Home Assistant should show for the user right now. `device` null means no player is open. */
export function buildHaState(device: DeviceInfo | null, friendlyName: string, now = Date.now()): { state: string; attributes: Record<string, unknown> } {
  const attributes: Record<string, unknown> = { friendly_name: friendlyName, icon: "mdi:music" };
  if (!device || !device.online) return { state: "off", attributes };
  const s = device.state;
  attributes["source"] = device.name;
  attributes["cadence_device_id"] = device.id;
  if (!s || !s.track) return { state: "idle", attributes };
  const artists = s.track.artists.map((a) => a.name).join(", ");
  attributes["media_title"] = s.track.title;
  if (artists) attributes["media_artist"] = artists;
  if (s.track.album) attributes["media_album_name"] = s.track.album;
  if (s.track.artwork) attributes["entity_picture"] = s.track.artwork;
  if (s.duration > 0) attributes["media_duration"] = Math.round(s.duration);
  attributes["media_position"] = Math.round(s.position);
  // Home Assistant adds the elapsed time itself while playing, using this timestamp as the reference.
  attributes["media_position_updated_at"] = new Date(s.updatedAt || now).toISOString();
  attributes["volume_level"] = s.volume;
  return { state: s.isPlaying ? "playing" : "paused", attributes };
}

export interface HaResult {
  ok: boolean;
  status: number;
  message: string;
}

const hint = (status: number) =>
  status === 401 || status === 403
    ? "Home Assistant rejected the token. Create a new long-lived access token in your Home Assistant profile."
    : status === 404
      ? "Home Assistant answered, but not at that address. Check the URL."
      : `Home Assistant answered with status ${status}.`;

/** Set an entity state with the official REST API: POST /api/states/<entity_id>. */
export async function pushState(target: HaTarget, payload: { state: string; attributes: Record<string, unknown> }): Promise<HaResult> {
  try {
    const res = await fetchText(
      `${target.url}/api/states/${encodeURIComponent(target.entityId)}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
      { timeoutMs: 6000, maxBytes: 256 * 1024 },
    );
    return res.ok ? { ok: true, status: res.status, message: "Sent." } : { ok: false, status: res.status, message: hint(res.status) };
  } catch {
    return { ok: false, status: 0, message: "Could not reach Home Assistant. Check the URL and that the server can see it." };
  }
}

/** GET /api/ confirms the token works ("API running."). */
export async function checkConnection(target: Pick<HaTarget, "url" | "token">): Promise<HaResult> {
  try {
    const res = await fetchText(`${target.url}/api/`, { headers: { authorization: `Bearer ${target.token}` } }, { timeoutMs: 6000, maxBytes: 64 * 1024 });
    return res.ok ? { ok: true, status: res.status, message: "Connected." } : { ok: false, status: res.status, message: hint(res.status) };
  } catch {
    return { ok: false, status: 0, message: "Could not reach Home Assistant. Check the URL and that the server can see it." };
  }
}
