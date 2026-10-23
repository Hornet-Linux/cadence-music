import { create } from "zustand";
import type { Track } from "@/shared/types";
import { ApiError, apiUrl, useServer } from "../../builtins/server/serverStore";
import type { AlbumQuery, Card, CardPage, ServerPage, TrackPage, TrackQuery } from "../sourcesCommon/types";
import { message, search } from "../sourcesCommon/types";

export const SUBSONIC_TRACK_PREFIX = "subsonic:";
const SESSION_EXPIRED = "subsonic_session_expired";
/** Reuse a signed stream URL until it has this many seconds left. */
const URL_MARGIN_SEC = 60;
/** Tracks kept in memory for the Library, Home and Search views. */
const FIRST_PAGE = 200;

export interface SubsonicStatus {
  configured: boolean;
  connected: boolean;
  serverName?: string;
  userName?: string;
}

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

interface SubsonicState {
  /** Null until the first check. */
  status: SubsonicStatus | null;
  checking: boolean;
  busy: boolean;
  error: string | null;
  /** Favourite flags changed on this device (or seen in a list), by Subsonic track id. */
  favourites: Record<string, boolean>;
  /** The first page of tracks, for the Library, Home and Search views. */
  tracks: Track[];
  loading: boolean;

  refresh: () => Promise<void>;
  connect: (username: string, password: string) => Promise<boolean>;
  disconnect: () => Promise<void>;
  /** Forget everything held for the previous person (they signed out of Cadence). */
  reset: () => void;
  loadLibrary: () => Promise<void>;

  listTracks: (query?: TrackQuery) => Promise<TrackPage>;
  listAlbums: (query?: AlbumQuery) => Promise<CardPage>;
  listArtists: (query?: { q?: string; limit?: number; offset?: number }) => Promise<CardPage>;
  albumTracks: (albumId: string) => Promise<Track[]>;
  listPlaylists: () => Promise<Card[]>;
  playlistTracks: (playlistId: string) => Promise<Track[]>;
  /** Star a track. Updates at once and rolls back if the server refuses. */
  toggleFavourite: (track: Track) => Promise<void>;
  /** A signed, playable URL for a track (cached until shortly before it expires). */
  streamUrl: (trackId: string) => Promise<string>;
  /** Tell Subsonic what is playing; a finished listen is scrobbled. Best effort. */
  report: (event: "start" | "stop", trackId: string, positionSec: number, durationSec: number) => Promise<void>;
}

/** The Subsonic track id of a Cadence track, or null for other sources. */
export function subsonicTrackId(track: { id: string }): string | null {
  return track.id.startsWith(SUBSONIC_TRACK_PREFIX) ? track.id.slice(SUBSONIC_TRACK_PREFIX.length) : null;
}

export function toTrack(t: ApiTrack, base: string): Track {
  return {
    id: `${SUBSONIC_TRACK_PREFIX}${t.id}`,
    title: t.title,
    artists: t.artists.length ? t.artists.map((name) => ({ id: name, name })) : [{ id: "unknown", name: "Unknown artist" }],
    album: t.album,
    artwork: t.artwork ? apiUrl(base, t.artwork) : undefined,
    durationSec: t.durationSec,
    source: "subsonic",
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

export const useSubsonic = create<SubsonicState>((set, get) => {
  /** Ids with a favourite toggle in flight, so a list refresh doesn't undo them. */
  const pending = new Set<string>();
  const streamUrls = new Map<string, { url: string; expiresAt: number }>();
  const base = () => useServer.getState().url;

  /** Call the server's Subsonic routes; a dead Subsonic sign-in signs out of Subsonic only. */
  async function call<T>(route: string, init?: RequestInit): Promise<T> {
    try {
      return await useServer.getState().api<T>(route, init);
    } catch (err) {
      if (err instanceof ApiError && err.code === SESSION_EXPIRED) {
        streamUrls.clear();
        set((s) => ({
          status: { ...(s.status ?? { configured: true }), configured: true, connected: false },
          error: "Your Subsonic sign-in stopped working. Sign in again.",
        }));
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
    favourites: {},
    tracks: [],
    loading: false,

    async refresh() {
      if (!useServer.getState().token) return get().reset();
      set({ checking: true });
      try {
        set({ status: await call<SubsonicStatus>("api/subsonic/status"), error: null });
        if (get().status?.connected) void get().loadLibrary();
      } catch (err) {
        // A server without this plugin turned on has no Subsonic routes; treat it as "not set up".
        set({ status: { configured: false, connected: false }, error: err instanceof ApiError && err.status === 404 ? null : message(err) });
      } finally {
        set({ checking: false });
      }
    },

    async connect(username, password) {
      set({ busy: true, error: null });
      try {
        set({
          status: await call<SubsonicStatus>("api/subsonic/connection", { method: "PUT", body: JSON.stringify({ username: username.trim(), password }) }),
          error: null,
        });
        void get().loadLibrary();
        return true;
      } catch (err) {
        const status = err instanceof ApiError ? err.status : 0;
        set({
          error:
            status === 422
              ? "Wrong Subsonic username or password."
              : status === 429
                ? "Too many attempts. Try again in a few minutes."
                : status === 502
                  ? "The server couldn't reach Subsonic. Try again in a moment."
                  : message(err),
        });
        return false;
      } finally {
        set({ busy: false });
      }
    },

    async disconnect() {
      set({ busy: true, error: null });
      try {
        await call<void>("api/subsonic/connection", { method: "DELETE" });
      } catch (err) {
        set({ busy: false, error: message(err) });
        return;
      }
      streamUrls.clear();
      set((s) => ({ busy: false, status: { configured: s.status?.configured ?? true, connected: false }, tracks: [], favourites: {} }));
    },

    reset() {
      streamUrls.clear();
      pending.clear();
      set({ status: null, checking: false, busy: false, error: null, favourites: {}, tracks: [], loading: false });
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
      const res = await call<ServerPage<ApiTrack>>(`api/subsonic/tracks${search({ ...query })}`);
      return { items: seen(res.items), total: res.total, hasMore: res.hasMore };
    },

    async listAlbums(query = {}) {
      const res = await call<ServerPage<ApiAlbum>>(`api/subsonic/albums${search({ ...query })}`);
      return { items: res.items.map((a) => albumCard(a, base())), total: res.total, hasMore: res.hasMore };
    },

    async listArtists(query = {}) {
      const res = await call<ServerPage<ApiArtist>>(`api/subsonic/artists${search({ ...query })}`);
      return { items: res.items.map((a) => artistCard(a, base())), total: res.total, hasMore: res.hasMore };
    },

    async albumTracks(albumId) {
      return seen((await call<ServerPage<ApiTrack>>(`api/subsonic/albums/${encodeURIComponent(albumId)}/tracks`)).items);
    },

    async listPlaylists() {
      return (await call<{ items: ApiPlaylist[] }>("api/subsonic/playlists")).items.map(playlistCard);
    },

    async playlistTracks(playlistId) {
      return seen((await call<ServerPage<ApiTrack>>(`api/subsonic/playlists/${encodeURIComponent(playlistId)}/tracks`)).items);
    },

    async toggleFavourite(track) {
      const id = subsonicTrackId(track);
      if (!id || pending.has(id)) return;
      const was = get().favourites[id] ?? false;
      pending.add(id);
      set((s) => ({ favourites: { ...s.favourites, [id]: !was } }));
      try {
        await call<void>(`api/subsonic/favourites/${encodeURIComponent(id)}`, { method: was ? "DELETE" : "PUT" });
      } catch (err) {
        set((s) => ({ favourites: { ...s.favourites, [id]: was }, error: message(err) }));
      } finally {
        pending.delete(id);
      }
    },

    async streamUrl(trackId) {
      const cached = streamUrls.get(trackId);
      if (cached && cached.expiresAt - Date.now() / 1000 > URL_MARGIN_SEC) return cached.url;
      const signed = await call<{ path: string; expiresAt: number }>(`api/subsonic/tracks/${encodeURIComponent(trackId)}/stream-url`);
      const url = apiUrl(base(), signed.path);
      streamUrls.set(trackId, { url, expiresAt: signed.expiresAt });
      return url;
    },

    async report(event, trackId, positionSec, durationSec) {
      try {
        await call<void>("api/subsonic/playback", {
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

/** Is this track starred in Subsonic? */
export function useIsFavourite(track: Track): boolean {
  const id = subsonicTrackId(track);
  return useSubsonic((s) => (id ? !!s.favourites[id] : false));
}