import type { DeviceInfo, HubCommand } from "../_devices/hub.js";

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Turn a Home Assistant request body into a player command. The names follow Home Assistant media_player
 * services (media_play, volume_set...) as well as short forms, so a rest_command can use either.
 */
export function commandFromBody(body: Record<string, unknown>, target: DeviceInfo | null): HubCommand | null {
  const name = typeof body["command"] === "string" ? body["command"].toLowerCase().replace(/^media_/, "") : "";
  switch (name) {
    case "play":
    case "pause":
    case "next":
    case "previous":
    case "toggle":
      return { type: name };
    case "play_pause":
      return { type: "toggle" };
    case "next_track":
      return { type: "next" };
    case "previous_track":
      return { type: "previous" };
    case "seek": {
      const position = num(body["position"] ?? body["seek_position"]);
      return position !== undefined && position >= 0 ? { type: "seek", position } : null;
    }
    case "volume":
    case "volume_set": {
      const level = num(body["volume"] ?? body["volume_level"]);
      return level !== undefined ? { type: "volume", volume: Math.min(1, Math.max(0, level)) } : null;
    }
    case "volume_up":
    case "volume_down": {
      const step = num(body["step"]) ?? 0.1;
      const current = target?.state?.volume ?? 0.5;
      return { type: "volume", volume: Math.min(1, Math.max(0, current + (name === "volume_up" ? step : -step))) };
    }
    default:
      return null;
  }
}

/** Pick the device a command is for: by id or name when given, else the one the user is listening on. */
export function pickDevice(devices: DeviceInfo[], wanted: unknown, active: DeviceInfo | null): DeviceInfo | null {
  if (typeof wanted === "string" && wanted.trim()) {
    const w = wanted.trim().toLowerCase();
    return devices.find((d) => d.id === wanted.trim()) ?? devices.find((d) => d.name.toLowerCase() === w) ?? null;
  }
  return active;
}
