import { create } from "zustand";
import type { Track } from "@/shared/types";
import { ApiError, apiUrl, useServer } from "../../builtins/server/serverStore";
import { plainError, remoteId, StreamLinkCache, toTrack, type RemoteStatus, type RemoteTrackDto } from "./logic";

export interface RemoteSourceConfig<S extends RemoteStatus> {
  /** Route area under /api/, such as "webdav" or "onedrive-gdrive/google". */
  area: string;
  /** Route for the status call when it isn't `<area>/status`. */
  statusRoute?: string;
  /** Pick this source's status out of the answer to the status call. */
  pickStatus?: (raw: unknown) => S;
  /** Cadence track id prefix, such as "webdav:". */
  prefix: string;
  /** `Track.source` value. */
  source: string;
  /** Name shown to people. */
  label: string;
}

/** What the store needs from the outside; tests replace these. */
export interface RemoteSourceDeps {
  api: <T>(route: string, init?: RequestInit) => Promise<T>;
  base: () => string;
  signedIn: () => boolean;
}

export const serverDeps: RemoteSourceDeps = {
  api: <T,>(route: string, init?: RequestInit) => useServer.getState().api<T>(route, init),
  base: () => useServer.getState().url,
  signedIn: () => !!useServer.getState().token,
};

/** Tracks kept in memory for Home, Library and Search (the Browse page pages through the rest). */
export const FIRST_PAGE = 300;
const POLL_MS = 2000;

export interface TrackPage {
  items: Track[];
  total: number;
}

export interface AlbumCard {
  name: string;
  artist: string | null;
  trackCount: number;
}

export interface RemoteSourceState<S extends RemoteStatus> {
  /** Null until the first answer. */
  status: S | null;
  /** The server doesn't have this plugin turned on. */
  unavailable: boolean;
  checking: boolean;
  busy: boolean;
  error: string | null;
  /** The first page of tracks, for Home, Library and Search. */
  tracks: Track[];
  trackTotal: number;

  refresh: () => Promise<void>;
  reset: () => void;
  /** Send a connect form (PUT <area>/connection). Returns whether it worked. */
  connect: (body: unknown) => Promise<boolean>;
  disconnect: () => Promise<void>;
  startIndex: () => Promise<void>;
  loadFirstPage: () => Promise<void>;
  listTracks: (query?: { q?: string; album?: string; limit?: number; offset?: number }) => Promise<TrackPage>;
  listAlbums: (query?: { q?: string; limit?: number; offset?: number }) => Promise<{ items: AlbumCard[]; total: number }>;
  streamUrl: (trackId: string) => Promise<string>;
  /** Call another route of this source (folders, admin). The route is relative to `<area>/`. */
  call: <T>(route: string, init?: RequestInit) => Promise<T>;
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function createRemoteSourceStore<S extends RemoteStatus>(cfg: RemoteSourceConfig<S>, deps: RemoteSourceDeps = serverDeps) {
  const links = new StreamLinkCache();
  let poll: ReturnType<typeof setTimeout> | null = null;

  const stopPolling = () => {
    if (poll) clearTimeout(poll);
    poll = null;
  };

  return create<RemoteSourceState<S>>((set, get) => {
    const route = (r: string) => `api/${cfg.area}/${r}`;
    const call = <T,>(r: string, init?: RequestInit) => deps.api<T>(route(r), init);

    function schedulePoll() {
      stopPolling();
      if (!get().status?.indexing.running) return;
      poll = setTimeout(() => {
        poll = null;
        void get().refresh();
      }, POLL_MS);
    }

    return {
      status: null,
      unavailable: false,
      checking: false,
      busy: false,
      error: null,
      tracks: [],
      trackTotal: 0,

      async refresh() {
        if (!deps.signedIn()) return get().reset();
        const wasRunning = !!get().status?.indexing.running;
        set({ checking: true });
        try {
          const raw = await deps.api<unknown>(cfg.statusRoute ?? route("status"));
          const status = cfg.pickStatus ? cfg.pickStatus(raw) : (raw as S);
          set({ status, unavailable: false, error: null });
          // Show new tracks as the indexer finds them, and once more when it ends.
          if (status.connected && (status.indexing.running || wasRunning)) await get().loadFirstPage();
          else if (status.connected && get().tracks.length === 0 && status.trackCount > 0) await get().loadFirstPage();
          if (!status.connected) set({ tracks: [], trackTotal: 0 });
        } catch (err) {
          // The server doesn't have the plugin turned on: its routes don't exist.
          if (err instanceof ApiError && err.status === 404) set({ status: null, unavailable: true, error: null });
          else set({ error: plainError(err) });
        } finally {
          set({ checking: false });
          schedulePoll();
        }
      },

      reset() {
        stopPolling();
        links.clear();
        set({ status: null, unavailable: false, checking: false, busy: false, error: null, tracks: [], trackTotal: 0 });
      },

      async connect(body) {
        set({ busy: true, error: null });
        try {
          await call("connection", { method: "PUT", body: JSON.stringify(body) });
          links.clear();
          await get().refresh();
          return true;
        } catch (err) {
          set({ error: plainError(err) });
          return false;
        } finally {
          set({ busy: false });
        }
      },

      async disconnect() {
        set({ busy: true, error: null });
        try {
          await call("connection", { method: "DELETE" });
          links.clear();
          set({ tracks: [], trackTotal: 0 });
          await get().refresh();
        } catch (err) {
          set({ error: plainError(err) });
        } finally {
          set({ busy: false });
        }
      },

      async startIndex() {
        set({ error: null });
        try {
          await call("index", { method: "POST" });
          await get().refresh();
        } catch (err) {
          set({ error: plainError(err) });
        }
      },

      async loadFirstPage() {
        try {
          const page = await get().listTracks({ limit: FIRST_PAGE });
          set({ tracks: page.items, trackTotal: page.total });
        } catch {
          // The Browse page shows its own errors; this only feeds Home and Library.
        }
      },

      async listTracks(query = {}) {
        const res = await call<{ items: RemoteTrackDto[]; total: number }>(`tracks${qs({ q: query.q, album: query.album, limit: query.limit ?? 100, offset: query.offset })}`);
        return { items: res.items.map((t) => toTrack(t, cfg.prefix, cfg.source)), total: res.total };
      },

      async listAlbums(query = {}) {
        return call<{ items: AlbumCard[]; total: number }>(`albums${qs({ q: query.q, limit: query.limit ?? 100, offset: query.offset })}`);
      },

      async streamUrl(trackId) {
        const id = remoteId({ id: trackId }, cfg.prefix) ?? trackId;
        const cached = links.get(id);
        if (cached) return cached;
        const signed = await call<{ path: string; expiresAt: number }>(`tracks/${encodeURIComponent(id)}/stream-url`);
        const url = apiUrl(deps.base(), signed.path);
        links.set(id, url, signed.expiresAt);
        return url;
      },

      call,
    };
  });
}
