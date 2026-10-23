import { randomUUID } from "node:crypto";
import { jsonRequest, type FetchFn } from "../_ops/http.js";

export interface SlskdStatus {
  version: string | null;
  connected: boolean;
  state: string | null;
  username: string | null;
}

export interface SlskdSearchState {
  id: string;
  searchText: string;
  state: string;
  isComplete: boolean;
  responseCount: number;
  fileCount: number;
}

export interface SlskdResponseSummary {
  username: string;
  freeUploadSlots: boolean;
  uploadSpeed: number;
  fileCount: number;
  files: { filename: string; size: number; bitRate: number | null; lengthSec: number | null; extension: string }[];
}

/**
 * The slskd REST API (https://github.com/slskd/slskd/blob/master/docs/api.md), used only to read status and to
 * search. Cadence never starts a download in slskd.
 */
export class SlskdClient {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchFn?: FetchFn,
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  private call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    return jsonRequest<T>(`${this.base}/api/v0/${path}`, { ...init, headers: { "x-api-key": this.apiKey }, fetchFn: this.fetchFn });
  }

  async status(): Promise<SlskdStatus> {
    const app = await this.call<{ version?: string; server?: { state?: string; isConnected?: boolean; isLoggedIn?: boolean }; user?: { username?: string } }>("application");
    const server = app.server ?? {};
    return {
      version: app.version ?? null,
      connected: Boolean(server.isConnected && server.isLoggedIn !== false),
      state: server.state ?? null,
      username: app.user?.username ?? null,
    };
  }

  /** Start a network search; poll `searchState` with the returned id. */
  async startSearch(text: string): Promise<string> {
    const id = randomUUID();
    await this.call("searches", { method: "POST", body: { id, searchText: text } });
    return id;
  }

  async searchState(id: string): Promise<SlskdSearchState> {
    const s = await this.call<Record<string, unknown>>(`searches/${encodeURIComponent(id)}`);
    return {
      id,
      searchText: String(s.searchText ?? ""),
      state: String(s.state ?? "Unknown"),
      isComplete: Boolean(s.isComplete),
      responseCount: Number(s.responseCount) || 0,
      fileCount: Number(s.fileCount) || 0,
    };
  }

  async searchResponses(id: string, limit = 30): Promise<SlskdResponseSummary[]> {
    const raw = await this.call<Record<string, unknown>[]>(`searches/${encodeURIComponent(id)}/responses`);
    return (raw ?? [])
      .slice(0, limit)
      .map((r) => {
        const files = (Array.isArray(r.files) ? r.files : []) as Record<string, unknown>[];
        return {
          username: String(r.username ?? ""),
          freeUploadSlots: Number(r.freeUploadSlots) > 0 || r.hasFreeUploadSlot === true,
          uploadSpeed: Number(r.uploadSpeed) || 0,
          fileCount: Number(r.fileCount) || files.length,
          files: files.slice(0, 8).map((f) => ({
            filename: String(f.filename ?? ""),
            size: Number(f.size) || 0,
            bitRate: typeof f.bitRate === "number" ? f.bitRate : null,
            lengthSec: typeof f.length === "number" ? f.length : null,
            extension: String(f.extension ?? String(f.filename ?? "").split(".").pop() ?? ""),
          })),
        };
      })
      .sort((a, b) => Number(b.freeUploadSlots) - Number(a.freeUploadSlots) || b.uploadSpeed - a.uploadSpeed);
  }

  /** Remove a finished search from slskd so it does not pile up. */
  async deleteSearch(id: string): Promise<void> {
    await this.call(`searches/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}