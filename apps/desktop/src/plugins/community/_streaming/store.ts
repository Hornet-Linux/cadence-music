import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { Track } from "@/shared/types";
import { ApiError, useServer } from "@/plugins/builtins/server/serverStore";
import type { AdminConfig, ServiceInfo, StreamPlaylist, StreamStatus, StreamTrack } from "./types";

export const POLL_MS = 2000;
export const POLL_LIMIT_MS = 3 * 60_000;

/** The Cadence track for a service's track. Ids look like "deezer:123". */
export function toTrack(info: Pick<ServiceInfo, "slug" | "prefix">, t: StreamTrack): Track {
  return {
    id: `${info.prefix}${t.id}`,
    title: t.title,
    artists: t.artists.length ? t.artists.map((name) => ({ id: name, name })) : [{ id: "unknown", name: "Unknown artist" }],
    album: t.album,
    artwork: t.artwork,
    durationSec: t.durationSec,
    source: info.slug,
  };
}

/** The service's own id inside a Cadence track id, or null for other sources. */
export function serviceId(info: Pick<ServiceInfo, "prefix">, track: { id: string }): string | null {
  return track.id.startsWith(info.prefix) ? track.id.slice(info.prefix.length) : null;
}

export interface StreamingState {
  /** Null until the first check. */
  status: StreamStatus | null;
  /** The server does not have the add-on (its routes answered 404). */
  missing: boolean;
  checking: boolean;
  busy: boolean;
  error: string | null;
  /** Set while waiting for the person to finish signing in in their browser. */
  waiting: boolean;
  signInUrl: string | null;
  library: Track[];
  libraryLoading: boolean;
  /** Where each track's page lives on the service, by Cadence track id (for "Open in ..."). */
  links: Record<string, string>;
  /** What each track can do, by Cadence track id. */
  playback: Record<string, StreamTrack["playback"]>;
  notes: Record<string, string>;
  adminConfig: AdminConfig | null;

  refresh: () => Promise<void>;
  reset: () => void;
  connect: () => Promise<void>;
  cancelConnect: () => void;
  disconnect: () => Promise<void>;
  search: (q: string) => Promise<Track[]>;
  loadLibrary: () => Promise<void>;
  playlists: () => Promise<StreamPlaylist[]>;
  playlistTracks: (id: string) => Promise<Track[]>;
  loadAdminConfig: () => Promise<void>;
  saveAdminConfig: (patch: Record<string, string | null>) => Promise<boolean>;
  /** GET a path under /api/streaming/<slug>/ (used by playback code). */
  get: <T>(path: string) => Promise<T>;
}

export type StreamingStore = UseBoundStore<StoreApi<StreamingState>>;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Work out the friendly text for a failed call. */
export function describe(e: unknown, name: string): string {
  if (e instanceof ApiError) {
    if (e.code?.endsWith("_not_configured")) return `${name} isn't set up on this server yet.`;
    if (e.code?.endsWith("_session_expired")) return `Your ${name} sign-in expired. Connect again.`;
    if (e.code?.endsWith("_not_connected")) return `Connect ${name} first.`;
    if (e.status === 429) return "Too many searches. Wait a moment and try again.";
    // The server's message for these is already a fixed, friendly phrase.
    const m = /: (.+)$/.exec(e.message);
    if (m && e.status >= 500) return m[1]!;
  }
  return message(e);
}

/** One store per streaming service. Talks only to the Cadence server, never to the service. */
export function createStreamingStore(info: ServiceInfo): StreamingStore {
  const route = (path: string) => `api/streaming/${info.slug}/${path}`;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollToken = 0;

  return create<StreamingState>((set, get) => {
    const call = <T>(path: string, init?: RequestInit) => useServer.getState().api<T>(route(path), init);

    function remember(items: StreamTrack[]): Track[] {
      const links: Record<string, string> = {};
      const playback: Record<string, StreamTrack["playback"]> = {};
      const notes: Record<string, string> = {};
      const tracks = items.map((t) => {
        const track = toTrack(info, t);
        if (t.url) links[track.id] = t.url;
        playback[track.id] = t.playback;
        if (t.note) notes[track.id] = t.note;
        return track;
      });
      set((s) => ({ links: { ...s.links, ...links }, playback: { ...s.playback, ...playback }, notes: { ...s.notes, ...notes } }));
      return tracks;
    }

    function stopPolling() {
      pollToken++;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
    }

    return {
      status: null,
      missing: false,
      checking: false,
      busy: false,
      error: null,
      waiting: false,
      signInUrl: null,
      library: [],
      libraryLoading: false,
      links: {},
      playback: {},
      notes: {},
      adminConfig: null,

      async refresh() {
        if (!useServer.getState().token) return get().reset();
        set({ checking: true });
        try {
          const status = await call<StreamStatus>("status");
          set({ status, missing: false, error: null });
          if (status.configured && status.connected && status.features.library && get().library.length === 0) void get().loadLibrary();
        } catch (e) {
          // An older server, or one where the admin has not turned the add-on on, has no such routes.
          if (e instanceof ApiError && e.status === 404) set({ status: null, missing: true, error: null });
          else set({ error: describe(e, info.name) });
        } finally {
          set({ checking: false });
        }
      },

      reset() {
        stopPolling();
        set({
          status: null,
          missing: false,
          checking: false,
          busy: false,
          error: null,
          waiting: false,
          signInUrl: null,
          library: [],
          libraryLoading: false,
          links: {},
          playback: {},
          notes: {},
          adminConfig: null,
        });
      },

      async connect() {
        stopPolling();
        set({ busy: true, error: null });
        try {
          const { url } = await call<{ url: string }>("connect/start", { method: "POST" });
          set({ signInUrl: url, waiting: true });
          // The sign-in happens in the browser; the server's callback page completes it.
          window.open(url, "_blank", "noopener");
          const token = ++pollToken;
          const started = Date.now();
          const tick = async () => {
            if (token !== pollToken) return;
            try {
              const status = await call<StreamStatus>("status");
              if (token !== pollToken) return;
              if (status.connected) {
                set({ status, waiting: false, signInUrl: null, error: null });
                void get().loadLibrary();
                return;
              }
              if (status.loginError) {
                set({ status, waiting: false, signInUrl: null, error: status.loginError });
                return;
              }
            } catch {
              // Keep waiting; a hiccup should not cancel the sign-in.
            }
            if (Date.now() - started > POLL_LIMIT_MS) {
              set({ waiting: false, signInUrl: null, error: "Timed out waiting for the sign-in. Try again." });
              return;
            }
            pollTimer = setTimeout(() => void tick(), POLL_MS);
          };
          pollTimer = setTimeout(() => void tick(), POLL_MS);
        } catch (e) {
          set({ error: describe(e, info.name), waiting: false });
        } finally {
          set({ busy: false });
        }
      },

      cancelConnect() {
        stopPolling();
        set({ waiting: false, signInUrl: null });
      },

      async disconnect() {
        stopPolling();
        set({ busy: true, error: null, waiting: false });
        try {
          await call<void>("connection", { method: "DELETE" });
          set((s) => ({ status: s.status ? { ...s.status, connected: false } : s.status, library: [] }));
        } catch (e) {
          set({ error: describe(e, info.name) });
        } finally {
          set({ busy: false });
        }
      },

      async search(q) {
        const res = await call<{ items: StreamTrack[] }>(`search?q=${encodeURIComponent(q)}`);
        return remember(res.items);
      },

      async loadLibrary() {
        if (!get().status?.features.library) return;
        set({ libraryLoading: true });
        try {
          const res = await call<{ items: StreamTrack[] }>("library/tracks?limit=50");
          set({ library: remember(res.items) });
        } catch (e) {
          if (e instanceof ApiError && e.code?.endsWith("_session_expired")) {
            set((s) => ({ status: s.status ? { ...s.status, connected: false } : s.status, library: [], error: describe(e, info.name) }));
          }
        } finally {
          set({ libraryLoading: false });
        }
      },

      async playlists() {
        const res = await call<{ items: StreamPlaylist[] }>("playlists");
        return res.items;
      },

      async playlistTracks(id) {
        const res = await call<{ items: StreamTrack[] }>(`playlists/${encodeURIComponent(id)}/tracks`);
        return remember(res.items);
      },

      async loadAdminConfig() {
        try {
          set({ adminConfig: await call<AdminConfig>("config") });
        } catch (e) {
          set({ error: describe(e, info.name) });
        }
      },

      async saveAdminConfig(patch) {
        set({ busy: true, error: null });
        try {
          await call<void>("config", { method: "PUT", body: JSON.stringify(patch) });
          await get().loadAdminConfig();
          await get().refresh();
          return true;
        } catch (e) {
          set({ error: e instanceof ApiError && e.status === 400 ? "One of the values has an invalid character or is too long." : describe(e, info.name) });
          return false;
        } finally {
          set({ busy: false });
        }
      },

      get: <T>(path: string) => call<T>(path),
    };
  });
}
