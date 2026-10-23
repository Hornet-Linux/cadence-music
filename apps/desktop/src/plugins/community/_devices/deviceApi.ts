import { useServer } from "../../builtins/server/serverStore";

export interface DeviceInfo {
  id: string;
  name: string;
  kind: string;
  model?: string;
  manufacturer?: string;
  address?: string;
  manual?: boolean;
}

export interface DeviceList {
  devices: DeviceInfo[];
  discovering?: boolean;
  lastScanAt?: number | null;
  hint?: string;
}

export interface DeviceStatus {
  state: "playing" | "paused" | "stopped" | "buffering" | "unknown";
  positionSec?: number;
  durationSec?: number;
  volume?: number;
  muted?: boolean;
}

export interface PlayRequest {
  trackId: string;
  positionSec: number;
  autoplay: boolean;
  title: string;
  artist?: string;
  album?: string;
  artwork?: string;
  durationSec?: number;
}

type Api = <T>(route: string, init?: RequestInit) => Promise<T>;

const post = (api: Api, route: string, body: unknown = {}) =>
  api<{ ok: boolean }>(route, { method: "POST", body: JSON.stringify(body) });

/** Calls to a server plugin that sends audio to devices on the network (`prefix` is "dlna" or "chromecast"). */
export function rendererApi(prefix: string, api: Api = (route, init) => useServer.getState().api(route, init)) {
  const base = `api/${prefix}`;
  const dev = (id: string) => `${base}/devices/${encodeURIComponent(id)}`;
  return {
    list: (refresh = false) => api<DeviceList>(`${base}/devices${refresh ? "?refresh=1" : ""}`),
    play: (id: string, req: PlayRequest) => post(api, `${dev(id)}/play`, req),
    pause: (id: string) => post(api, `${dev(id)}/pause`),
    resume: (id: string) => post(api, `${dev(id)}/resume`),
    stop: (id: string) => post(api, `${dev(id)}/stop`),
    seek: (id: string, positionSec: number) => post(api, `${dev(id)}/seek`, { positionSec }),
    setVolume: (id: string, volume: number) => post(api, `${dev(id)}/volume`, { volume }),
    status: (id: string) => api<DeviceStatus>(`${dev(id)}/status`),
    addManual: (address: string) => api<DeviceInfo>(`${base}/devices/manual`, { method: "POST", body: JSON.stringify({ address }) }),
    removeManual: (id: string) => api<{ removed: boolean }>(`${base}/devices/manual/${encodeURIComponent(id)}`, { method: "DELETE" }),
    getConfig: () => api<{ streamBaseUrl: string | null }>(`${base}/config`),
    setConfig: (streamBaseUrl: string | null) =>
      api<{ streamBaseUrl: string | null }>(`${base}/config`, { method: "PUT", body: JSON.stringify({ streamBaseUrl }) }),
  };
}

export type RendererApi = ReturnType<typeof rendererApi>;
