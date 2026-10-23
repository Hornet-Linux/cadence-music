import type { DeviceInfo, DeviceState, HubCommand, HubConnection, StateEvent } from "./hub.js";

interface Entry {
  info: DeviceInfo;
  conn: HubConnection | null;
}

const OFFLINE_GRACE_MS = 90_000;

export type DeliverResult = "delivered" | "unknown" | "offline";

/** In-memory registry of each user's connected players and a relay for commands and state. */
export class DeviceHub {
  private readonly users = new Map<number, Map<string, Entry>>();
  private readonly stateListeners = new Set<(e: StateEvent) => void>();
  private readonly presenceListeners = new Set<(userId: number) => void>();
  /** Set by the remote-control plugin so other plugins can tell the relay is running. */
  active = false;

  constructor(private readonly now: () => number = Date.now) {}

  private devices(userId: number): Map<string, Entry> {
    let m = this.users.get(userId);
    if (!m) this.users.set(userId, (m = new Map()));
    return m;
  }

  /** Drop devices that have been offline longer than the grace period. */
  prune(): void {
    const t = this.now();
    for (const [userId, map] of this.users) {
      for (const [id, e] of map) if (!e.conn && t - e.info.lastSeen > OFFLINE_GRACE_MS) map.delete(id);
      if (map.size === 0) this.users.delete(userId);
    }
  }

  list(userId: number): DeviceInfo[] {
    this.prune();
    return [...(this.users.get(userId)?.values() ?? [])]
      .map((e) => ({ ...e.info, online: e.conn !== null }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  get(userId: number, deviceId: string): DeviceInfo | null {
    const e = this.users.get(userId)?.get(deviceId);
    return e ? { ...e.info, online: e.conn !== null } : null;
  }

  private broadcastDevices(userId: number): void {
    for (const l of this.presenceListeners) {
      try {
        l(userId);
      } catch {
        // a listener must not break the relay
      }
    }
    const list = this.list(userId);
    for (const e of this.users.get(userId)?.values() ?? []) e.conn?.send("devices", { devices: list });
  }

  /**
   * Register a player's stream. A second connection with the same device id (a reconnect, or the app opened
   * twice) replaces the first. Returns a function that ends this registration.
   */
  connect(userId: number, device: { id: string; name: string; kind: string }, conn: HubConnection): () => void {
    const map = this.devices(userId);
    const existing = map.get(device.id);
    const previous = existing?.conn;
    const entry: Entry = {
      info: { id: device.id, name: device.name, kind: device.kind, online: true, lastSeen: this.now(), state: existing?.info.state ?? null },
      conn,
    };
    map.set(device.id, entry);
    if (previous && previous !== conn) {
      previous.send("replaced", {});
      previous.close();
    }
    this.broadcastDevices(userId);
    return () => {
      const current = this.users.get(userId)?.get(device.id);
      // A replaced connection ending must not take the new one offline.
      if (!current || current.conn !== conn) return;
      current.conn = null;
      current.info.lastSeen = this.now();
      this.broadcastDevices(userId);
    };
  }

  /** Record a device's reported state and tell the user's other devices. */
  updateState(userId: number, deviceId: string, state: DeviceState): boolean {
    const entry = this.users.get(userId)?.get(deviceId);
    if (!entry) return false;
    entry.info.state = state;
    entry.info.lastSeen = this.now();
    const device = { ...entry.info, online: entry.conn !== null };
    for (const [id, other] of this.users.get(userId) ?? []) if (id !== deviceId) other.conn?.send("state", { device });
    for (const l of this.stateListeners) {
      try {
        l({ userId, device });
      } catch {
        // a listener must not break the relay
      }
    }
    return true;
  }

  /** Send a command to one of the user's devices. */
  deliver(userId: number, targetId: string, command: HubCommand, from: string | null): DeliverResult {
    const entry = this.users.get(userId)?.get(targetId);
    if (!entry) return "unknown";
    if (!entry.conn) return "offline";
    entry.conn.send("command", { command, from });
    return "delivered";
  }

  /** The device this user is most likely listening on: a playing one, else the most recently active online one. */
  activeDevice(userId: number): DeviceInfo | null {
    const online = this.list(userId).filter((d) => d.online);
    const playing = online.filter((d) => d.state?.isPlaying).sort((a, b) => (b.state?.updatedAt ?? 0) - (a.state?.updatedAt ?? 0));
    return (
      playing[0] ??
      [...online].sort((a, b) => (b.state?.updatedAt ?? 0) - (a.state?.updatedAt ?? 0) || b.lastSeen - a.lastSeen)[0] ??
      null
    );
  }

  /** Called when one of the user devices connects or goes offline. */
  onPresence(listener: (userId: number) => void): () => void {
    this.presenceListeners.add(listener);
    return () => this.presenceListeners.delete(listener);
  }

  onState(listener: (e: StateEvent) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** End every stream (server shutdown). */
  closeAll(): void {
    for (const map of this.users.values()) {
      for (const e of map.values()) {
        const c = e.conn;
        e.conn = null;
        c?.close();
      }
    }
  }
}

/** The shared relay used by the remote-control and Home Assistant plugins. */
export const deviceHub = new DeviceHub();
