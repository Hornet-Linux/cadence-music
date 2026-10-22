import { create } from "zustand";
import type { Track } from "@/shared/types";
import { describeError, query, sendJson, serverApi, serverUrl } from "../_sourcekit/api";
import { rewindSeconds } from "../_sourcekit/format";
import { createMediaHandle, type MediaHandle, type TickInfo } from "../_sourcekit/handle";

export const PODCAST_PREFIX = "podcast:";

export interface Show {
  id: string;
  title: string;
  author: string;
  description: string;
  link?: string;
  image?: string;
  subscribed: boolean;
  /** Set on a show opened from search, so it can be subscribed to from there. */
  feedUrl?: string;
  speed?: number;
  autoQueue?: boolean;
  unplayed?: number;
}

export interface Episode {
  id: string;
  feedId: string;
  title: string;
  description: string;
  durationSec: number;
  publishedAt: number | null;
  season?: number;
  episode?: number;
  hasChapters: boolean;
  image?: string;
  feedTitle?: string;
  author?: string;
  position: number;
  played: boolean;
  progressAt: number | null;
}

export interface DirectoryHit {
  feedUrl: string;
  title: string;
  author: string;
  image?: string;
  description?: string;
  subscribed: boolean;
}

export const episodeIdOf = (track: { id: string }): string | null => (track.id.startsWith(PODCAST_PREFIX) ? track.id.slice(PODCAST_PREFIX.length) : null);

export function episodeToTrack(e: Episode): Track {
  return {
    id: `${PODCAST_PREFIX}${e.id}`,
    title: e.title,
    artists: [{ id: e.feedId, name: e.feedTitle ?? "Podcast" }],
    album: e.feedTitle ?? "Podcast",
    artwork: serverUrl(e.image),
    durationSec: e.durationSec || undefined,
    source: "podcasts",
  };
}

/** Where to start an episode: the saved place, a few seconds earlier after a break; from the top when finished or barely started. */
export function startPosition(detail: { position: number; played: boolean; progressAt: number | null }, now = Date.now()): number {
  if (detail.played || detail.position < 10) return 0;
  const idle = detail.progressAt ? now - detail.progressAt : Number.POSITIVE_INFINITY;
  return Math.max(0, detail.position - rewindSeconds(idle));
}

// ---- reporting listening progress ----------------------------------------------------------

export interface ProgressSend {
  (episodeId: string, body: { position: number; duration?: number; played?: boolean; updatedAt?: number }): Promise<void>;
}

/**
 * Sends the listening position to the server: every `everyMs` while playing, and whenever it pauses, ends or
 * stops. A report that fails is kept and sent with the next one (stamped with when it was true, so the server
 * can tell it from newer news from another device).
 */
export function createProgressReporter(send: ProgressSend, opts: { everyMs?: number; now?: () => number } = {}) {
  const everyMs = opts.everyMs ?? 15_000;
  const now = opts.now ?? Date.now;
  let lastSent = 0;
  let pending: { episodeId: string; position: number; duration?: number; played?: boolean; at: number } | null = null;

  async function flush(episodeId: string, position: number, duration: number | undefined, played: boolean | undefined) {
    const retry = pending && pending.episodeId === episodeId ? pending.at : undefined;
    const at = now();
    pending = { episodeId, position, duration, played, at };
    try {
      await send(episodeId, { position, ...(duration ? { duration } : {}), ...(played !== undefined ? { played } : {}), ...(retry ? { updatedAt: at } : {}) });
      pending = null;
      lastSent = at;
    } catch {
      // Kept in `pending`; the next report carries it.
    }
  }

  return {
    onTick(episodeId: string, info: TickInfo): Promise<void> | void {
      if (info.reason === "end") return flush(episodeId, info.duration || info.position, info.duration || undefined, true);
      if (info.reason === "pause" || info.reason === "seek") return flush(episodeId, info.position, info.duration || undefined, undefined);
      if (info.playing && now() - lastSent >= everyMs) {
        lastSent = now();
        return flush(episodeId, info.position, info.duration || undefined, undefined);
      }
    },
    stopped(episodeId: string, position: number, duration: number | undefined): Promise<void> {
      return flush(episodeId, position, duration, undefined);
    },
    get hasPending() {
      return pending !== null;
    },
  };
}

// ---- playback -----------------------------------------------------------------------------

export interface ActivePlayback {
  episodeId: string;
  feedId: string;
  handle: MediaHandle;
}
let active: ActivePlayback | null = null;
export const activePlayback = (): ActivePlayback | null => active;

const reporter = createProgressReporter((id, body) =>
  serverApi<unknown>(`api/podcasts/episodes/${encodeURIComponent(id)}/progress`, sendJson("PUT", body)).then(() => undefined),
);

interface Detail extends Episode {
  speed: number;
  autoQueue: boolean;
}

/** The queue hook the plugin fills in on activation (auto-queue appends the next episodes). */
let enqueue: ((t: Track) => void) | null = null;
let queued: () => string[] = () => [];
export function connectQueue(add: (t: Track) => void, ids: () => string[]) {
  enqueue = add;
  queued = ids;
}

export async function queueFollowing(episodeId: string, feedId: string, count = 2): Promise<void> {
  if (!enqueue) return;
  const res = await serverApi<{ items: Episode[] }>(`api/podcasts/feeds/${feedId}/next${query({ after: episodeId, count })}`);
  const have = new Set(queued());
  for (const e of res.items) {
    const track = episodeToTrack(e);
    if (!have.has(track.id)) enqueue(track);
  }
}

export async function resolveEpisode(episodeId: string): Promise<MediaHandle> {
  const [detail, stream] = await Promise.all([
    serverApi<Detail>(`api/podcasts/episodes/${encodeURIComponent(episodeId)}`),
    serverApi<{ path: string }>(`api/podcasts/episodes/${encodeURIComponent(episodeId)}/stream-url`),
  ]);
  const duration = detail.durationSec;
  const handle = createMediaHandle({
    segments: [{ url: serverUrl(stream.path)!, startOffset: 0, duration }],
    totalDuration: duration || undefined,
    startAt: startPosition(detail),
    rate: detail.speed,
    onTick: (info) => {
      if (info.reason === "end") usePodcasts.getState().noteProgress(episodeId, { position: 0, played: true });
      else if (info.reason !== "tick") usePodcasts.getState().noteProgress(episodeId, { position: info.position, played: false });
      void reporter.onTick(episodeId, info);
    },
    onStop: (position) => {
      if (active?.handle === handle) active = null;
      void reporter.stopped(episodeId, position, duration || undefined);
    },
  });
  active = { episodeId, feedId: detail.feedId, handle };
  usePodcasts.getState().setPlaybackRate(handle.rate);
  if (detail.autoQueue) void queueFollowing(episodeId, detail.feedId).catch(() => undefined);
  return handle;
}

// ---- the store --------------------------------------------------------------------------------

interface PodcastState {
  shows: Show[];
  showsLoaded: boolean;
  fresh: Episode[];
  freshLoaded: boolean;
  error: string | null;
  /** Local overrides so a row updates the moment a person acts, before the server answers. */
  progress: Record<string, { position: number; played: boolean }>;
  /** Speed of whatever is playing now. */
  rate: number;
  loadShows: () => Promise<void>;
  loadFresh: () => Promise<void>;
  subscribe: (feedUrl: string) => Promise<Show | null>;
  unsubscribe: (feedId: string) => Promise<void>;
  setShowSpeed: (feedId: string, speed: number) => Promise<void>;
  setAutoQueue: (feedId: string, on: boolean) => Promise<void>;
  setPlayed: (episodeId: string, played: boolean) => Promise<void>;
  noteProgress: (episodeId: string, p: { position: number; played: boolean }) => void;
  setPlaybackRate: (rate: number) => void;
  /** Change the speed of what is playing, and remember it for that show. */
  changeSpeed: (rate: number) => Promise<void>;
  refresh: () => Promise<{ newEpisodes: number } | null>;
  reset: () => void;
}

export const usePodcasts = create<PodcastState>((set, get) => ({
  shows: [],
  showsLoaded: false,
  fresh: [],
  freshLoaded: false,
  error: null,
  progress: {},
  rate: 1,

  async loadShows() {
    try {
      const res = await serverApi<{ items: Show[] }>("api/podcasts/subscriptions");
      set({ shows: res.items, showsLoaded: true, error: null });
    } catch (e) {
      set({ showsLoaded: true, error: describeError(e, "podcasts") });
    }
  },

  async loadFresh() {
    try {
      const res = await serverApi<{ items: Episode[] }>("api/podcasts/new?limit=40");
      set({ fresh: res.items, freshLoaded: true, error: null });
    } catch (e) {
      set({ freshLoaded: true, error: describeError(e, "podcasts") });
    }
  },

  async subscribe(feedUrl) {
    try {
      const show = await serverApi<Show>("api/podcasts/subscriptions", sendJson("POST", { feedUrl }));
      set({ error: null });
      await Promise.all([get().loadShows(), get().loadFresh()]);
      return show;
    } catch (e) {
      set({ error: describeError(e, "podcasts") });
      return null;
    }
  },

  async unsubscribe(feedId) {
    const before = get().shows;
    set({ shows: before.filter((s) => s.id !== feedId) });
    try {
      await serverApi<void>(`api/podcasts/subscriptions/${feedId}`, sendJson("DELETE"));
      void get().loadFresh();
    } catch (e) {
      set({ shows: before, error: describeError(e, "podcasts") });
    }
  },

  async setShowSpeed(feedId, speed) {
    const before = get().shows;
    set({ shows: before.map((s) => (s.id === feedId ? { ...s, speed } : s)) });
    try {
      await serverApi<Show>(`api/podcasts/subscriptions/${feedId}`, sendJson("PATCH", { speed }));
    } catch (e) {
      set({ shows: before, error: describeError(e, "podcasts") });
    }
  },

  async setAutoQueue(feedId, on) {
    const before = get().shows;
    set({ shows: before.map((s) => (s.id === feedId ? { ...s, autoQueue: on } : s)) });
    try {
      await serverApi<Show>(`api/podcasts/subscriptions/${feedId}`, sendJson("PATCH", { autoQueue: on }));
    } catch (e) {
      set({ shows: before, error: describeError(e, "podcasts") });
    }
  },

  async setPlayed(episodeId, played) {
    const prev = get().progress[episodeId];
    set((s) => ({ progress: { ...s.progress, [episodeId]: { position: 0, played } } }));
    try {
      await serverApi<unknown>(`api/podcasts/episodes/${episodeId}/progress`, sendJson("PUT", { position: 0, played }));
      void get().loadShows();
    } catch (e) {
      set((s) => {
        const progress = { ...s.progress };
        if (prev) progress[episodeId] = prev;
        else delete progress[episodeId];
        return { progress, error: describeError(e, "podcasts") };
      });
    }
  },

  noteProgress: (episodeId, p) => set((s) => ({ progress: { ...s.progress, [episodeId]: p } })),
  setPlaybackRate: (rate) => set({ rate }),

  async changeSpeed(rate) {
    const current = active;
    if (!current) return;
    current.handle.setRate(rate);
    set({ rate });
    await get().setShowSpeed(current.feedId, rate);
  },

  async refresh() {
    try {
      const res = await serverApi<{ newEpisodes: number }>("api/podcasts/refresh", sendJson("POST"));
      await Promise.all([get().loadShows(), get().loadFresh()]);
      return res;
    } catch (e) {
      set({ error: describeError(e, "podcasts") });
      return null;
    }
  },

  reset: () => set({ shows: [], showsLoaded: false, fresh: [], freshLoaded: false, error: null, progress: {}, rate: 1 }),
}));

/** The row state for an episode: server truth, unless this device just changed it. */
export function stateOf(e: Episode, local: Record<string, { position: number; played: boolean }>): { position: number; played: boolean } {
  return local[e.id] ?? { position: e.position, played: e.played };
}

export async function searchDirectory(q: string): Promise<{ source: string; items: DirectoryHit[] }> {
  return serverApi(`api/podcasts/search${query({ q })}`);
}

export async function previewShow(feedUrl: string): Promise<Show> {
  return serverApi<Show>("api/podcasts/subscriptions", sendJson("POST", { feedUrl, preview: true }));
}

export async function fetchEpisodes(feedId: string, opts: { offset?: number; order?: "newest" | "oldest"; limit?: number } = {}): Promise<{ feed: Show; items: Episode[]; total: number }> {
  return serverApi(`api/podcasts/feeds/${feedId}/episodes${query({ offset: opts.offset, order: opts.order === "oldest" ? "oldest" : undefined, limit: opts.limit ?? 40 })}`);
}

export async function importOpml(opml: string): Promise<{ found: number; added: number; alreadySubscribed: number }> {
  return serverApi("api/podcasts/opml", sendJson("POST", { opml }));
}

export async function podcastAdmin(): Promise<{ podcastIndexConfigured: boolean; podcastIndexKey: string | null }> {
  return serverApi("api/podcasts/admin");
}

export async function savePodcastAdmin(body: { podcastIndexKey: string | null; podcastIndexSecret?: string }): Promise<{ podcastIndexConfigured: boolean; podcastIndexKey: string | null }> {
  return serverApi("api/podcasts/admin", sendJson("PUT", body));
}