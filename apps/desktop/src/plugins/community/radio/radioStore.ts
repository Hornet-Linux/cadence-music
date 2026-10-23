import { create } from "zustand";
import type { Track } from "@/shared/types";
import { describeError, serverApi, sendJson, serverUrl } from "../_sourcekit/api";
import { joinFacts } from "../_sourcekit/format";

export const RADIO_PREFIX = "radio:";

export interface RadioStation {
  id: string;
  name: string;
  country: string;
  countryCode: string;
  language: string;
  tags: string[];
  codec: string;
  bitrate: number;
  hls: boolean;
  votes: number;
  clicks: number;
  homepage?: string;
  /** Relative signed path to the logo (proxied by the server). */
  favicon?: string;
}

export interface Facet {
  name: string;
  count: number;
  code?: string;
}

export interface StationPage {
  items: RadioStation[];
  hasMore: boolean;
}

export function stationIdOf(track: { id: string }): string | null {
  return track.id.startsWith(RADIO_PREFIX) ? track.id.slice(RADIO_PREFIX.length) : null;
}

export function stationToTrack(s: RadioStation): Track {
  return {
    id: `${RADIO_PREFIX}${s.id}`,
    title: s.name,
    artists: [{ id: "radio", name: joinFacts([s.country, s.tags[0]]) || "Internet radio" }],
    album: "Internet radio",
    artwork: serverUrl(s.favicon),
    source: "radio",
  };
}

export function describeStation(s: RadioStation): string {
  return joinFacts([s.country, s.codec && `${s.codec}${s.bitrate ? ` ${s.bitrate} kbps` : ""}`, s.hls && "live HLS", s.tags.slice(0, 2).join(", ")]);
}

export interface NowPlaying {
  stationId: string;
  /** The ICY "StreamTitle" the station sends, e.g. "Artist - Song". */
  title: string | null;
}

interface RadioState {
  favourites: RadioStation[];
  favouritesLoaded: boolean;
  error: string | null;
  nowPlaying: NowPlaying | null;
  loadFavourites: () => Promise<void>;
  toggleFavourite: (station: RadioStation) => Promise<void>;
  setNowPlaying: (np: NowPlaying | null) => void;
  reset: () => void;
}

export const useRadio = create<RadioState>((set, get) => ({
  favourites: [],
  favouritesLoaded: false,
  error: null,
  nowPlaying: null,

  async loadFavourites() {
    try {
      const res = await serverApi<{ items: RadioStation[] }>("api/radio/favourites");
      set({ favourites: res.items, favouritesLoaded: true, error: null });
    } catch (e) {
      set({ favouritesLoaded: true, error: describeError(e, "internet radio") });
    }
  },

  async toggleFavourite(station) {
    const before = get().favourites;
    const has = before.some((s) => s.id === station.id);
    // Updates at once; rolls back if the server refuses.
    set({ favourites: has ? before.filter((s) => s.id !== station.id) : [station, ...before], error: null });
    try {
      if (has) await serverApi<void>(`api/radio/favourites/${encodeURIComponent(station.id)}`, sendJson("DELETE"));
      else await serverApi<RadioStation>(`api/radio/favourites/${encodeURIComponent(station.id)}`, sendJson("PUT"));
    } catch (e) {
      set({ favourites: before, error: describeError(e, "internet radio") });
    }
  },

  setNowPlaying: (nowPlaying) => set({ nowPlaying }),
  reset: () => set({ favourites: [], favouritesLoaded: false, error: null, nowPlaying: null }),
}));

export const isFavourite = (favs: RadioStation[], id: string): boolean => favs.some((s) => s.id === id);

export interface StationQuery {
  mode: "top" | "trending" | "search";
  name?: string;
  country?: string;
  language?: string;
  tag?: string;
  offset?: number;
  limit?: number;
}

export async function fetchStations(q: StationQuery): Promise<StationPage> {
  const limit = q.limit ?? 30;
  if (q.mode === "search") {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ name: q.name, country: q.country, language: q.language, tag: q.tag })) if (v) params.set(k, v);
    params.set("limit", String(limit));
    params.set("offset", String(q.offset ?? 0));
    return serverApi<StationPage>(`api/radio/stations?${params}`);
  }
  return serverApi<StationPage>(`api/radio/${q.mode}?limit=${limit}`);
}

export async function fetchFacets(kind: "tags" | "countries" | "languages"): Promise<Facet[]> {
  return (await serverApi<{ items: Facet[] }>(`api/radio/facets/${kind}`)).items;
}

/** A playable address for a station and whether it is an HLS playlist. */
export async function streamFor(stationId: string): Promise<{ url: string; hls: boolean }> {
  const res = await serverApi<{ path: string; hls: boolean }>(`api/radio/stations/${encodeURIComponent(stationId)}/stream-url`);
  return { url: serverUrl(res.path)!, hls: res.hls };
}

export async function fetchNowPlaying(stationId: string): Promise<string | null> {
  const res = await serverApi<{ title: string | null }>(`api/radio/stations/${encodeURIComponent(stationId)}/now-playing`);
  return res.title;
}

/**
 * Follows the "now playing" text of whichever station is playing: asks right away, then every `everyMs`
 * while it stays current. Returns a function that stops. Replies for a station that is no longer playing are dropped.
 */
export function watchNowPlaying(
  stationId: string,
  onTitle: (title: string | null) => void,
  opts: { everyMs?: number; fetchTitle?: (id: string) => Promise<string | null> } = {},
): () => void {
  const fetchTitle = opts.fetchTitle ?? fetchNowPlaying;
  let live = true;
  let last: string | null | undefined;
  const poll = async () => {
    try {
      const title = await fetchTitle(stationId);
      if (live && title !== last) {
        last = title;
        onTitle(title);
      }
    } catch {
      // The title is a nicety; the audio keeps playing.
    }
  };
  void poll();
  const timer = setInterval(() => void poll(), opts.everyMs ?? 12_000);
  return () => {
    live = false;
    clearInterval(timer);
  };
}

/** Puts the station's current song on the lock screen / notification (Android, media keys). */
export function announce(track: Track | null, title: string | null): void {
  const session = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
  if (!session || !track || typeof MediaMetadata === "undefined") return;
  session.metadata = new MediaMetadata({
    title: title ?? track.title,
    artist: title ? track.title : (track.artists[0]?.name ?? ""),
    album: "Internet radio",
    artwork: track.artwork ? [{ src: track.artwork, sizes: "300x300" }] : [],
  });
}