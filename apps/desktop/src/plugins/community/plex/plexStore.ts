import { create } from "zustand";
import type { Track } from "@/shared/types";
import { ApiError, apiUrl, useServer } from "../../builtins/server/serverStore";
import type { AlbumQuery, Card, CardPage, ServerPage, TrackPage, TrackQuery } from "../sourcesCommon/types";
import { message, search } from "../sourcesCommon/types";

export const PLEX_TRACK_PREFIX = "plex:";
const SESSION_EXPIRED = "plex_session_expired";
const NO_LIBRARY = "plex_no_library";
/** Reuse a signed stream URL until it has this many seconds left. */
const URL_MARGIN_SEC = 60;
const FIRST_PAGE = 200;

export interface PlexLibrary {
  key: string;
  title: string;
}

export interface PlexStatus {
  configured: boolean;
  connected: boolean;
  serverName?: string;
  userName?: string;
  library?: PlexLibrary;
  needsLibrary?: boolean;
}

export interface PlexLink {
  code: string;
  linkUrl: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export type LinkState = "idle" | "waiting" | "expired" | "no_access";

type PinPoll = { state: "waiting"; expiresAt: number } | { state: "expired" } | { state: "no_access" } | { state: "connected"; status: PlexStatus };

interface ApiTrack {
  id: string;
  title: string;
  artists: string[];
  album?: string;
  durationSec?: number;
  artwork?: string;
  favourite?: boolean;
}
interface ApiAlbum {
  id: string;
  name: string;
  artist?: string;
  year?: number;
  artwork?: string;
}
interface ApiArtist {
  id: string;
  name: string;
  albumCount?: number;
  artwork?: string;
}
interface ApiPlaylist {
  id: string;
  name: string;
  trackCount: number;
}

interface PlexState {
  status: PlexStatus | null;
  checking: boolean;
  busy: boolean;
  error: string | null;
  /** The code to type at plex.tv/link while linking. */
  link: PlexLink | null;
  linkState: LinkState;
  libraries: PlexLibrary[];
  favourites: Record<string, boolean>;
  tracks: Track[];
  loading: boolean;

  refresh: () => Promise<void>;
  /** Ask plex.tv for a code. */
  startLink: () => Promise<void>;
  /** Has the code been entered yet? Call every few seconds while a link is open. */
  pollLink: () => Promise<void>;
  cancelLink: () => void;
  disconnect: () => Promise<void>;
  loadLibraries: () => Promise<void>;
  chooseLibrary: (key: string) => Promise<void>;
  reset: () => void;
  loadLibrary: () => Promise<void>;

  listTracks: (query?: TrackQuery) => Promise<TrackPage>;
  listAlbums: (query?: AlbumQuery) => Promise<CardPage>;
  listArtists: (query?: { q?: string; limit?: number; offset?: number }) => Promise<CardPage>;
  albumTracks: (albumId: string) => Promise<Track[]>;
  listPlaylists: () => Promise<Card[]>;
  playlistTracks: (playlistId: string) => Promise<Track[]>;
  toggleFavourite: (track: Track) => Promise<void>;
  streamUrl: (trackId: string) => Promise<string>;
  report: (event: "start" | "stop", trackId: string, positionSec: number, durationSec: number) => Promise<void>;
}

/** The Plex rating key of a Cadence track, or null for other sources. */
export function plexTrackId(track: { id: string }): string | null {
  return track.id.startsWith(PLEX_TRACK_PREFIX) ? track.id.slice(PLEX_TRACK_PREFIX.length) : null;
}

export function toTrack(t: ApiTrack, base: string): Track {
  return {
    id: `${PLEX_TRACK_PREFIX}${t.id}`,
    title: t.title,
    artists: t.artists.length ? t.artists.map((name) => ({ id: name, name })) : [{ id: "unknown", name: "Unknown artist" }],
    album: t.album,
    artwork: t.artwork ? apiUrl(base, t.artwork) : undefined,
    durationSec: t.durationSec,
    source: "plex",
  };
}

const albumCard = (a: ApiAlbum, base: string): Card => ({
  id: a.id,
  name: a.name,
  subtitle: [a.artist, a.year].filter(Boolean).join(" · ") || undefined,
  artwork: a.artwork ? apiUrl(base, a.artwork) : undefined,
});

const artistCard = (a: ApiArtist, base: string): Card => ({
  id: a.id,
  name: a.name,
  subtitle: a.albumCount === undefined ? undefined : `${a.albumCount} ${a.albumCount === 1 ? "album" : "albums"}`,
  artwork: a.artwork ? apiUrl(base, a.artwork) : undefined,
});

const playlistCard = (p: ApiPlaylist): Card => ({ id: p.id, name: p.name, subtitle: `${p.trackCount} ${p.trackCount === 1 ? "track" : "tracks"}` });

export const usePlex = create<PlexState>((set, get) => {
  const pending = new Set<string>();
  const streamUrls = new Map<string, { url: string; expiresAt: number }>();
  const base = () => useServer.getState().url;

  /** Call the server's Plex routes; a dead Plex sign-in signs out of Plex only. */
  async function call<T>(route: string, init?: RequestInit): Promise<T> {
    try {
      return await useServer.getState().api<T>(route, init);
    } catch (err) {
      if (err instanceof ApiError && err.code === SESSION_EXPIRED) {
        streamUrls.clear();
        set((s) => ({
          status: { ...(s.status ?? { configured: true }), configured: true, connected: false },
          link: null,
          linkState: "idle",
          error: "Your Plex sign-in stopped working. Link your account again.",
        }));
      } else if (err instanceof ApiError && err.code === NO_LIBRARY) {
        set((s) => ({ status: s.status ? { ...s.status, needsLibrary: true, library: undefined } : s.status }));
      }
      throw err;
    }
  }

  function seen(items: ApiTrack[]): Track[] {
    const flags: Record<string, boolean> = {};
    for (const t of items) if (!pending.has(t.id)) flags[t.id] = !!t.favourite;
    if (items.length) set((s) => ({ favourites: { ...s.favourites, ...flags } }));
    return items.map((t) => toTrack(t, base()));
  }

  return {
    status: null,
    checking: false,
    busy: false,
    error: null,
    link: null,
    linkState: "idle",
    libraries: [],
    favourites: {},
    tracks: [],
    loading: false,

    async refresh() {
      if (!useServer.getState().token) return get().reset();
      set({ checking: true });
      try {
        set({ status: await call<PlexStatus>("api/plex/status"), error: null });
        if (get().status?.connected && get().status?.library) void get().loadLibrary();
      } catch (err) {
        set({ status: { configured: false, connected: false }, error: err instanceof ApiError && err.status === 404 ? null : message(err) });
      } finally {
        set({ checking: false });
      }
    },

    async startLink() {
      set({ busy: true, error: null });
      try {
        const link = await call<PlexLink>("api/plex/pin", { method: "POST" });
        set({ link, linkState: "waiting" });
      } catch (err) {
        set({ error: err instanceof ApiError && err.status === 429 ? "Too many attempts. Try again in a few minutes." : err instanceof ApiError && err.status === 502 ? "Couldn't get a code from plex.tv. Try again in a moment." : message(err) });
      } finally {
        set({ busy: false });
      }
    },

    async pollLink() {
      if (!get().link) return;
      try {
        const res = await call<PinPoll>("api/plex/pin");
        if (res.state === "connected") {
          set({ status: res.status, link: null, linkState: "idle", error: null });
          if (res.status.library) void get().loadLibrary();
          else void get().loadLibraries();
        } else if (res.state === "expired") {
          set({ link: null, linkState: "expired" });
        } else if (res.state === "no_access") {
          set({ link: null, linkState: "no_access" });
        }
      } catch (err) {
        // The code is gone on the server (404), or plex.tv hiccuped: only the first ends the link.
        if (err instanceof ApiError && err.status === 404) set({ link: null, linkState: "expired" });
        else if (!(err instanceof ApiError && (err.status === 502 || err.status === 0))) set({ error: message(err) });
      }
    },

    cancelLink() {
      set({ link: null, linkState: "idle" });
    },

    async disconnect() {
      set({ busy: true, error: null });
      try {
        await call<void>("api/plex/connection", { method: "DELETE" });
      } catch (err) {
        set({ busy: false, error: message(err) });
        return;
      }
      streamUrls.clear();
      set((s) => ({ busy: false, status: { configured: s.status?.configured ?? true, connected: false }, tracks: [], favourites: {}, libraries: [] }));
    },

    async loadLibraries() {
      try {
        const res = await call<{ items: PlexLibrary[]; selected: string | null }>("api/plex/libraries");
        set({ libraries: res.items });
      } catch (err) {
        set({ error: message(err) });
      }
    },

    async chooseLibrary(key) {
      set({ busy: true, error: null });
      try {
        const status = await call<PlexStatus>("api/plex/library", { method: "PUT", body: JSON.stringify({ key }) });
        set({ status });
        void get().loadLibrary();
      } catch (err) {
        set({ error: message(err) });
      } finally {
        set({ busy: false });
      }
    },

    reset() {
      streamUrls.clear();
      pending.clear();
      set({ status: null, checking: false, busy: false, error: null, link: null, linkState: "idle", libraries: [], favourites: {}, tracks: [], loading: false });
    },

    async loadLibrary() {
      set({ loading: true });
      try {
        const page = await get().listTracks({ limit: FIRST_PAGE });
        set({ tracks: page.items });
      } catch {
        // The page shows its own errors; this is only the cache for Library and Search.
      } finally {
        set({ loading: false });
      }
    },

    async listTracks(query = {}) {
      const res = await call<ServerPage<ApiTrack>>(`api/plex/tracks${search({ ...query })}`);
      return { items: seen(res.items), total: res.total, hasMore: res.hasMore };
    },

    async listAlbums(query = {}) {
      const res = await call<ServerPage<ApiAlbum>>(`api/plex/albums${search({ ...query })}`);
      return { items: res.items.map((a) => albumCard(a, base())), total: res.total, hasMore: res.hasMore };
    },

    async listArtists(query = {}) {
      const res = await call<ServerPage<ApiArtist>>(`api/plex/artists${search({ ...query })}`);
      return { items: res.items.map((a) => artistCard(a, base())), total: res.total, hasMore: res.hasMore };
    },

    async albumTracks(albumId) {
      return seen((await call<ServerPage<ApiTrack>>(`api/plex/albums/${encodeURIComponent(albumId)}/tracks`)).items);
    },

    async listPlaylists() {
      return (await call<{ items: ApiPlaylist[] }>("api/plex/playlists")).items.map(playlistCard);
    },

    async playlistTracks(playlistId) {
      return seen((await call<ServerPage<ApiTrack>>(`api/plex/playlists/${encodeURIComponent(playlistId)}/tracks`)).items);
    },

    async toggleFavourite(track) {
      const id = plexTrackId(track);
      if (!id || pending.has(id)) return;
      const was = get().favourites[id] ?? false;
      pending.add(id);
      set((s) => ({ favourites: { ...s.favourites, [id]: !was } }));
      try {
        await call<void>(`api/plex/favourites/${encodeURIComponent(id)}`, { method: was ? "DELETE" : "PUT" });
      } catch (err) {
        set((s) => ({ favourites: { ...s.favourites, [id]: was }, error: message(err) }));
      } finally {
        pending.delete(id);
      }
    },

    async streamUrl(trackId) {
      const cached = streamUrls.get(trackId);
      if (cached && cached.expiresAt - Date.now() / 1000 > URL_MARGIN_SEC) return cached.url;
      const signed = await call<{ path: string; expiresAt: number }>(`api/plex/tracks/${encodeURIComponent(trackId)}/stream-url`);
      const url = apiUrl(base(), signed.path);
      streamUrls.set(trackId, { url, expiresAt: signed.expiresAt });
      return url;
    },

    async report(event, trackId, positionSec, durationSec) {
      try {
        await call<void>("api/plex/playback", {
          method: "POST",
          body: JSON.stringify({
            event,
            itemId: trackId,
            positionSec: Math.max(0, Math.round(positionSec * 10) / 10),
            ...(durationSec > 0 && Number.isFinite(durationSec) ? { durationSec: Math.round(durationSec * 10) / 10 } : {}),
          }),
        });
      } catch {
        // Reporting is best effort.
      }
    },
  };
});

/** Is this track a favourite in Plex? */
export function useIsFavourite(track: Track): boolean {
  const id = plexTrackId(track);
  return usePlex((s) => (id ? !!s.favourites[id] : false));
}