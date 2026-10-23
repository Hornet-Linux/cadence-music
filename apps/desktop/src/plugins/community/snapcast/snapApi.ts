import { useServer } from "../../builtins/server/serverStore";

export interface SnapClient {
  id: string;
  name: string;
  host?: string;
  connected: boolean;
  volume: number;
  muted: boolean;
}
export interface SnapGroup {
  id: string;
  name: string;
  streamId: string;
  muted: boolean;
  clients: SnapClient[];
}
export interface SnapStatus {
  configured: boolean;
  groups: SnapGroup[];
  streams: { id: string; status: string }[];
  serverVersion?: string;
}

const api = <T,>(route: string, init?: RequestInit) => useServer.getState().api<T>(route, init);
const post = (route: string, body: unknown) => api<{ ok: boolean }>(route, { method: "POST", body: JSON.stringify(body) });
const enc = encodeURIComponent;

export const snapApi = {
  status: () => api<SnapStatus>("api/snapcast/status"),
  getConfig: () => api<{ address: string | null }>("api/snapcast/config"),
  setConfig: (address: string | null) => api<{ address: string | null }>("api/snapcast/config", { method: "PUT", body: JSON.stringify({ address }) }),
  setClientVolume: (id: string, percent: number) => post(`api/snapcast/clients/${enc(id)}/volume`, { percent }),
  setClientMuted: (id: string, muted: boolean) => post(`api/snapcast/clients/${enc(id)}/mute`, { muted }),
  setGroupMuted: (id: string, muted: boolean) => post(`api/snapcast/groups/${enc(id)}/mute`, { muted }),
  setGroupStream: (id: string, streamId: string) => post(`api/snapcast/groups/${enc(id)}/stream`, { streamId }),
};
