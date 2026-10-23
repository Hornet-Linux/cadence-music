import { create } from "zustand";
import { useServer } from "../../builtins/server/serverStore";
import type { LinkStatus } from "./remoteLink";
import type { RemoteCommand, RemoteDevice } from "./types";

interface RemoteStoreState {
  status: LinkStatus;
  deviceId: string;
  deviceName: string;
  devices: RemoteDevice[];
  /** The device the Remote page is controlling. */
  selectedId: string | null;
  /** When each device's state last arrived here (local clock), to estimate the position between reports. */
  receivedAt: Record<string, number>;
  setDevices: (devices: RemoteDevice[]) => void;
  upsertDevice: (device: RemoteDevice) => void;
  select: (id: string | null) => void;
}

const NAME_KEY = "plugin:cadence.remote-control:name";
const ID_KEY = "plugin:cadence.remote-control:device-id";

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `dev-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** One id per tab or app window (sessionStorage), so two tabs are two players; it survives a reload. */
export function loadDeviceId(): string {
  try {
    const saved = sessionStorage.getItem(ID_KEY);
    if (saved) return saved;
    const fresh = randomId();
    sessionStorage.setItem(ID_KEY, fresh);
    return fresh;
  } catch {
    return randomId();
  }
}

export function renewDeviceId(): string {
  const fresh = randomId();
  try {
    sessionStorage.setItem(ID_KEY, fresh);
  } catch {
    // keep going with the in-memory id
  }
  useRemote.setState({ deviceId: fresh });
  return fresh;
}

export function defaultDeviceName(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/android/i.test(ua)) return "Android phone";
  if (/iphone|ipad/i.test(ua)) return "iPhone or iPad";
  if (/electron/i.test(ua)) return "Cadence desktop";
  return "Cadence in a browser";
}

export function loadDeviceName(): string {
  try {
    return localStorage.getItem(NAME_KEY) || defaultDeviceName();
  } catch {
    return defaultDeviceName();
  }
}

export function saveDeviceName(name: string): void {
  const trimmed = name.trim().slice(0, 60);
  try {
    if (trimmed) localStorage.setItem(NAME_KEY, trimmed);
    else localStorage.removeItem(NAME_KEY);
  } catch {
    // not persisted
  }
  useRemote.setState({ deviceName: trimmed || defaultDeviceName() });
}

export const useRemote = create<RemoteStoreState>((set) => ({
  status: "off",
  deviceId: loadDeviceId(),
  deviceName: loadDeviceName(),
  devices: [],
  selectedId: null,
  receivedAt: {},
  setDevices: (devices) =>
    set((s) => {
      const receivedAt = { ...s.receivedAt };
      const now = Date.now();
      for (const d of devices) if (d.state && !(d.id in receivedAt)) receivedAt[d.id] = now;
      return { devices, receivedAt };
    }),
  upsertDevice: (device) =>
    set((s) => ({
      devices: s.devices.some((d) => d.id === device.id) ? s.devices.map((d) => (d.id === device.id ? device : d)) : [...s.devices, device],
      receivedAt: { ...s.receivedAt, [device.id]: Date.now() },
    })),
  select: (selectedId) => set({ selectedId }),
}));

/** Other players of this user (never this one). */
export function selectOthers(devices: RemoteDevice[], selfId: string): RemoteDevice[] {
  return devices.filter((d) => d.id !== selfId);
}

/** Ask the server to relay a command to one of this user's devices. */
export async function sendRemoteCommand(targetId: string, command: RemoteCommand): Promise<void> {
  const from = useRemote.getState().deviceId;
  await useServer.getState().api(`api/remote-control/devices/${encodeURIComponent(targetId)}/command`, {
    method: "POST",
    body: JSON.stringify({ command, from }),
  });
}

/** Where the other player probably is now: its last report plus the time since, while it is playing. */
export function estimatedPosition(device: RemoteDevice, receivedAt: number | undefined, now = Date.now()): number {
  const s = device.state;
  if (!s) return 0;
  const elapsed = s.isPlaying && receivedAt ? (now - receivedAt) / 1000 : 0;
  const pos = s.position + elapsed;
  return s.duration > 0 ? Math.min(pos, s.duration) : pos;
}
