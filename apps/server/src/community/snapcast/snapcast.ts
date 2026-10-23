import { DeviceError } from "../_devices/rendererRoutes.js";
import type { RpcCall } from "./rpc.js";

export interface SnapClient {
  id: string;
  name: string;
  host?: string;
  connected: boolean;
  /** 0..100 */
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

export interface SnapStream {
  id: string;
  status: string;
}

export interface SnapStatus {
  groups: SnapGroup[];
  streams: SnapStream[];
  serverVersion?: string;
}

interface RawStatus {
  server?: {
    server?: { snapserver?: { version?: string } };
    groups?: {
      id: string;
      name?: string;
      stream_id?: string;
      muted?: boolean;
      clients?: {
        id: string;
        connected?: boolean;
        host?: { name?: string };
        config?: { name?: string; volume?: { muted?: boolean; percent?: number } };
      }[];
    }[];
    streams?: { id: string; status?: string }[];
  };
}

/** Turn Server.GetStatus into the small shape the UI needs. */
export function normalizeStatus(raw: unknown): SnapStatus {
  const server = (raw as RawStatus | undefined)?.server;
  const groups: SnapGroup[] = (server?.groups ?? []).map((g) => ({
    id: g.id,
    name: g.name || "",
    streamId: g.stream_id ?? "",
    muted: g.muted === true,
    clients: (g.clients ?? []).map((c) => ({
      id: c.id,
      name: c.config?.name || c.host?.name || c.id,
      host: c.host?.name,
      connected: c.connected !== false,
      volume: Math.min(100, Math.max(0, Math.round(c.config?.volume?.percent ?? 100))),
      muted: c.config?.volume?.muted === true,
    })),
  }));
  return {
    groups,
    streams: (server?.streams ?? []).map((s) => ({ id: s.id, status: s.status ?? "unknown" })),
    serverVersion: server?.server?.snapserver?.version,
  };
}

const ID = /^[\w:.-]{1,100}$/;
export const validId = (id: string) => ID.test(id);

/** Snapcast control over JSON-RPC: read the state, set volume and mute, switch streams, move clients. */
export class SnapcastClient {
  constructor(private readonly rpc: RpcCall) {}

  async status(): Promise<SnapStatus> {
    return normalizeStatus(await this.rpc("Server.GetStatus"));
  }

  private async findClient(id: string): Promise<SnapClient> {
    const client = (await this.status()).groups.flatMap((g) => g.clients).find((c) => c.id === id);
    if (!client) throw new DeviceError("That Snapcast client was not found.");
    return client;
  }

  async setClientVolume(id: string, percent: number, muted?: boolean): Promise<void> {
    const current = muted === undefined ? await this.findClient(id) : null;
    await this.rpc("Client.SetVolume", {
      id,
      volume: { percent: Math.min(100, Math.max(0, Math.round(percent))), muted: muted ?? current?.muted ?? false },
    });
  }

  async setClientMuted(id: string, muted: boolean): Promise<void> {
    const client = await this.findClient(id);
    await this.rpc("Client.SetVolume", { id, volume: { percent: client.volume, muted } });
  }

  async setGroupMuted(id: string, mute: boolean): Promise<void> {
    await this.rpc("Group.SetMute", { id, mute });
  }

  async setGroupStream(id: string, streamId: string): Promise<void> {
    await this.rpc("Group.SetStream", { id, stream_id: streamId });
  }

  async setGroupClients(id: string, clients: string[]): Promise<void> {
    await this.rpc("Group.SetClients", { id, clients });
  }
}
