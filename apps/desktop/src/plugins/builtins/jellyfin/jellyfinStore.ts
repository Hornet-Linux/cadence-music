import { create } from "zustand";
import type {
  DjTasteProfile,
  JellyfinAlbum,
  JellyfinAlbumsResponse,
  JellyfinPlaybackReport,
  JellyfinPlaylist,
  JellyfinPlaylistsResponse,
  JellyfinStatusResponse,
  JellyfinStreamUrlResponse,
  JellyfinTrack,
  JellyfinTracksResponse,
} from "@uma/shared";
import type { Track } from "@/shared/types";
import { ApiError, apiUrl, useServer } from "../server/serverStore";

export const JELLYFIN_TRACK_PREFIX = "jellyfin:";
const SESSION_EXPIRED = "jellyfin_session_expired";
/** Reuse a signed stream URL until it has this many seconds left. */
const URL_MARGIN_SEC = 60;
/** Tracks and albums kept in memory for the Jellyfin page's first view. */
const FIRST_PAGE = 200;

/** An album or playlist with its cover already pointing at the server. */
export interface JellyfinCard {
  id: string;
  name: string;
  /** Artist for an album; "N tracks" for a playlist. */
  subtitle?: string;
  artwork?: string;
}

export interface TrackQuery {
  q?: string;
  artist?: string;
  album?: string;
  albumId?: string;
  favourites?: boolean;
  limit?: number;
  offset?: number;
}

export interface TrackPage {
  items: Track[];
  total: number;
}

export interface CardPage {
  items: JellyfinCard[];
  total: number;
}

interface JellyfinState {
  /** Null until the first check. */
  status: JellyfinStatusResponse | null;
  checking: boolean;
  busy: boolean;
  error: string | null;
  /** Favourite flags changed on this device (or seen in a list), by Jellyfin item id. */
  favourites: Record<string, boolean>;
  /** The first page of tracks, for quick plays and the DJ's empty state. */
  tracks: Track[];
  trackTotal: number;
  loading: boolean;

  /** Ask the server whether Jellyfin is set up and whether this person is signed in. */
  refresh: () => Promise<void>;
  connect: (username: string, password: string) => Promise<boolean>;
  disconnect: () => Promise<void>;
  /** Forget everything held for the previous person (they signed out of Cadence). */
  reset: () => void;
  loadLibrary: () => Promise<void>;

  listTracks: (query?: TrackQuery) => Promise<TrackPage>;
  listAlbums: (query?: { q?: string; artist?: string; limit?: number; offset?: number }) => Promise<CardPage>;
  albumTracks: (albumId: string) => Promise<Track[]>;
  listPlaylists: () => Promise<JellyfinCard[]>;
  playlistTracks: (playlistId: string) => Promise<Track[]>;
  /** Heart a track in Jellyfin. Updates at once and rolls back if the server refuses. */
  toggleFavourite: (track: Track) => Promise<void>;
  /** A signed, playable URL for a Jellyfin item (cached until shortly before it expires). */
  streamUrl: (itemId: string) => Promise<string>;
  /** Library tracks matching songs the AI DJ picked. Same order; null when not in the library. */
  match: (picks: { artist: string; title: string }[]) => Promise<(Track | null)[]>;
  taste: () => Promise<DjTasteProfile>;
  /** Tell Jellyfin what is playing. Best effort: failures are ignored. */
  report: (event: JellyfinPlaybackReport["event"], itemId: string, positionSec: number) => Promise<void>;
}

/** The Jellyfin item id of a Cadence track, or null for other sources. */
export function jellyfinItemId(track: { id: string }): string | null {
  return track.id.startsWith(JELLYFIN_TRACK_PREFIX) ? track.id.slice(JELLYFIN_TRACK_PREFIX.length) : null;
}

export function toTrack(t: JellyfinTrack, base: string): Track {
  return {
    id: `${JELLYFIN_TRACK_PREFIX}${t.id}`,
    title: t.title,
    artists: t.artists.length ? t.artists.map((name) => ({ id: name, name })) : [{ id: "unknown", name: "Unknown artist" }],
    album: t.album,
    artwork: t.artwork ? apiUrl(base, t.artwork) : undefined,
    durationSec: t.durationSec,
    source: "jellyfin",
  };
}

function albumCard(a: JellyfinAlbum, base: string): JellyfinCard {
  const subtitle = [a.artist, a.year].filter(Boolean).join(" · ");
  return { id: a.id, name: a.name, subtitle: subtitle || undefined, artwork: a.artwork ? apiUrl(base, a.artwork) : undefined };
}

function playlistCard(p: JellyfinPlaylist, base: string): JellyfinCard {
  return {
    id: p.id,
    name: p.name,
    subtitle: `${p.trackCount} ${p.trackCount === 1 ? "track" : "tracks"}`,
    artwork: p.artwork ? apiUrl(base, p.artwork) : undefined,
  };
}

function search(params: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "" || value === false) continue;
    qs.set(key, value === true ? "1" : String(value));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useJellyfin = create<JellyfinState>((set, get) => {
  /** Item ids with a favourite toggle in flight, so a list refresh doesn't undo them. */
  const pending = new Set<string>();
  const streamUrls = new Map<string, { url: string; expiresAt: number }>();

  const base = () => useServer.getState().url;

  /** Call the server's Jellyfin routes; an expired Jellyfin session signs out of Jellyfin only. */
  async function call<T>(route: string, init?: RequestInit): Promise<T> {
    try {
      return await useServer.getState().api<T>(route, init);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && err.code === SESSION_EXPIRED) {
        streamUrls.clear();
        set((s) => ({
          status: { ...(s.status ?? { configured: true }), configured: true, connected: false },
          error: "Your Jellyfin session expired. Sign in again.",
        }));
      }
      throw err;
    }
  }

  /** Remember which of these the person has hearted, except ones being changed right now. */
  function seen(items: JellyfinTrack[]): Track[] {
    const flags: Record<string, boolean> = {};
    for (const t of items) if (!pending.has(t.id)) flags[t.id] = !!t.favourite;
    if (items.length) set((s) => ({ favourites: { ...s.favourites, ...flags } }));
    return items.map((t) => toTrack(t, base()));
  }

  function applyStatus(status: JellyfinStatusResponse) {
    set({ status, error: null });
  }

  return {
    status: null,
    checking: false,
    busy: false,
    error: null,
    favourites: {},
    tracks: [],
    trackTotal: 0,
    loading: false,

    async refresh() {
      if (!useServer.getState().token) return get().reset();
      set({ checking: true });
      try {
        applyStatus(await call<JellyfinStatusResponse>("api/jellyfin/status"));
        if (get().status?.connected) void get().loadLibrary();
      } catch (err) {
        // An older server has no Jellyfin routes; treat it as "not set up".
        set({ status: { configured: false, connected: false }, error: err instanceof ApiError && err.status === 404 ? null : message(err) });
      } finally {
        set({ checking: false });
      }
    },

    async connect(username, password) {
      set({ busy: true, error: null });
      try {
        applyStatus(
          await call<JellyfinStatusResponse>("api/jellyfin/connection", {
            method: "PUT",
            body: JSON.stringify({ username: username.trim(), password }),
          }),
        );
        void get().loadLibrary();
        return true;
      } catch (err) {
        const status = err instanceof ApiError ? err.status : 0;
        set({
          error:
            status === 401
              ? "Wrong Jellyfin username or password."
              : status === 502
                ? "The server couldn't reach Jellyfin. Try again in a moment."
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
        await call<void>("api/jellyfin/connection", { method: "DELETE" });
      } catch (err) {
        // Already signed out is fine; anything else keeps the person signed in.
        if (!(err instanceof ApiError && err.status === 401)) {
          set({ busy: false, error: message(err) });
          return;
        }
      }
      streamUrls.clear();
      set((s) => ({
        busy: false,
        status: { configured: s.status?.configured ?? true, connected: false },
        tracks: [],
        trackTotal: 0,
        favourites: {},
      }));
    },

    reset() {
      streamUrls.clear();
      pending.clear();
      set({ status: null, checking: false, busy: false, error: null, favourites: {}, tracks: [], trackTotal: 0, loading: false });
    },

    async loadLibrary() {
      set({ loading: true });
      try {
        const page = await get().listTracks({ limit: FIRST_PAGE });
        set({ tracks: page.items, trackTotal: page.total });
      } catch {
        // The page shows its own errors; this is only the quick-start cache.
      } finally {
        set({ loading: false });
      }
    },

    async listTracks(query = {}) {
      const res = await call<JellyfinTracksResponse>(`api/jellyfin/tracks${search({ ...query })}`);
      return { items: seen(res.items), total: res.total };
    },

    async listAlbums(query = {}) {
      const res = await call<JellyfinAlbumsResponse>(`api/jellyfin/albums${search({ ...query })}`);
      return { items: res.items.map((a) => albumCard(a, base())), total: res.total };
    },

    async albumTracks(albumId) {
      const res = await call<JellyfinTracksResponse>(`api/jellyfin/albums/${encodeURIComponent(albumId)}/tracks`);
      return seen(res.items);
    },

    async listPlaylists() {
      const res = await call<JellyfinPlaylistsResponse>("api/jellyfin/playlists");
      return res.items.map((p) => playlistCard(p, base()));
    },

    async playlistTracks(playlistId) {
      const res = await call<JellyfinTracksResponse>(`api/jellyfin/playlists/${encodeURIComponent(playlistId)}/tracks`);
      return seen(res.items);
    },

    async toggleFavourite(track) {
      const id = jellyfinItemId(track);
      if (!id || pending.has(id)) return;
      const was = get().favourites[id] ?? false;
      pending.add(id);
      set((s) => ({ favourites: { ...s.favourites, [id]: !was } }));
      try {
        await call<void>(`api/jellyfin/favourites/${encodeURIComponent(id)}`, { method: was ? "DELETE" : "PUT" });
      } catch (err) {
        set((s) => ({ favourites: { ...s.favourites, [id]: was }, error: message(err) }));
      } finally {
        pending.delete(id);
      }
    },

    async streamUrl(itemId) {
      const cached = streamUrls.get(itemId);
      if (cached && cached.expiresAt - Date.now() / 1000 > URL_MARGIN_SEC) return cached.url;
      const signed = await call<JellyfinStreamUrlResponse>(`api/jellyfin/tracks/${encodeURIComponent(itemId)}/stream-url`);
      const url = apiUrl(base(), signed.path);
      streamUrls.set(itemId, { url, expiresAt: signed.expiresAt });
      return url;
    },

    async match(picks) {
      if (picks.length === 0) return [];
      const res = await call<{ matches: (JellyfinTrack | null)[] }>("api/jellyfin/match", {
        method: "POST",
        body: JSON.stringify({ picks }),
      });
      const found = seen(res.matches.filter((m): m is JellyfinTrack => !!m));
      let i = 0;
      return res.matches.map((m) => (m ? found[i++] : null));
    },

    taste() {
      return call<DjTasteProfile>("api/jellyfin/taste");
    },

    async report(event, itemId, positionSec) {
      try {
        await call<void>("api/jellyfin/playback", {
          method: "POST",
          body: JSON.stringify({ event, itemId, positionSec: Math.max(0, Math.round(positionSec * 10) / 10) }),
        });
      } catch {
        // Reporting is best effort.
      }
    },
  };
});

/** Is this track hearted in Jellyfin? */
export function useIsFavourite(track: Track): boolean {
  const id = jellyfinItemId(track);
  return useJellyfin((s) => (id ? !!s.favourites[id] : false));
}
