import { create } from "zustand";
import type { Track } from "@/shared/types";
import { ApiError } from "../../builtins/server/serverStore";
import { describeError, query, sendJson, serverApi, serverUrl } from "../_sourcekit/api";
import { createMediaHandle, type MediaHandle, type SleepTimer, type TickInfo } from "../_sourcekit/handle";

export const BOOK_PREFIX = "audiobook:";
const SPEED_KEY = "cadence.audiobooks.speed";
/** A few seconds back when picking a book up again, so a sleepy "where was I?" gets a little context. */
export const RESUME_REWIND_SEC = 10;

export interface Book {
  id: string;
  libraryId?: string;
  title: string;
  subtitle?: string;
  author?: string;
  narrator?: string;
  series?: string;
  durationSec: number;
  cover?: string;
  progress?: { currentTime: number; progress: number; isFinished: boolean; lastUpdate: number };
  description?: string;
  year?: string;
  chapters?: Chapter[];
}

export interface Chapter {
  index: number;
  start: number;
  end: number;
  title: string;
}

export interface Bookmark {
  time: number;
  title: string;
  createdAt: number;
}

export interface Status {
  configured: boolean;
  connected: boolean;
  userName?: string;
}

interface PlaySession {
  sessionId: string;
  durationSec: number;
  startTime: number;
  chapters: Chapter[];
  tracks: { index: number; startOffset: number; durationSec: number; path: string }[];
}

export const bookIdOf = (track: { id: string }): string | null => (track.id.startsWith(BOOK_PREFIX) ? track.id.slice(BOOK_PREFIX.length) : null);

export function bookToTrack(b: Book): Track {
  return {
    id: `${BOOK_PREFIX}${b.id}`,
    title: b.title,
    artists: [{ id: b.author ?? "unknown", name: b.author ?? "Unknown author" }],
    album: b.series ?? b.title,
    artwork: serverUrl(b.cover),
    durationSec: b.durationSec || undefined,
    source: "audiobooks",
  };
}

/** The chapter that contains `position`, if the book has chapters. */
export function chapterAt(chapters: Chapter[], position: number): Chapter | null {
  let found: Chapter | null = null;
  for (const c of chapters) if (c.start <= position + 0.001) found = c;
  return found;
}

/** Where a sleep timer "until the end of this chapter" should stop; null when there are no chapters. */
export function chapterEnd(chapters: Chapter[], position: number): number | null {
  return chapterAt(chapters, position)?.end ?? null;
}

export function resumeAt(startTime: number): number {
  return startTime > 30 ? Math.max(0, startTime - RESUME_REWIND_SEC) : startTime;
}

export const SLEEP_MINUTES = [10, 20, 30, 45, 60] as const;

export function readSpeed(): number {
  try {
    const n = Number(localStorage.getItem(SPEED_KEY));
    return n >= 0.5 && n <= 4 ? n : 1;
  } catch {
    return 1;
  }
}
export function saveSpeed(rate: number): void {
  try {
    localStorage.setItem(SPEED_KEY, String(rate));
  } catch {
    // Not remembered, still applied.
  }
}

// ---- reporting listening to Audiobookshelf ---------------------------------------------------

export interface SyncSend {
  sync: (sessionId: string, body: { currentTime: number; timeListened: number; duration: number; itemId: string }) => Promise<void>;
  close: (sessionId: string, body: { currentTime: number; timeListened: number; duration: number; itemId: string }) => Promise<void>;
  finished: (itemId: string, duration: number) => Promise<void>;
}

/**
 * Reports the listening position back to Audiobookshelf: every `everyMs` while playing, when it pauses or seeks,
 * and when the session closes. Tracks how long the person actually listened (real time, capped per gap) so
 * their stats are right. A report that fails keeps its listened time for the next one.
 */
export function createSessionSync(sessionId: string, itemId: string, send: SyncSend, opts: { everyMs?: number; now?: () => number } = {}) {
  const everyMs = opts.everyMs ?? 15_000;
  const now = opts.now ?? Date.now;
  let lastSent = now();
  let lastTick = 0;
  let owed = 0;

  const body = (position: number, duration: number) => ({ currentTime: position, timeListened: Math.round(owed), duration, itemId });

  async function push(kind: "sync" | "close", position: number, duration: number) {
    const b = body(position, duration);
    try {
      await send[kind](sessionId, b);
      owed -= b.timeListened;
      lastSent = now();
    } catch {
      // Keep the listened time; the next report includes it.
    }
  }

  return {
    async onTick(info: TickInfo): Promise<void> {
      const t = now();
      // Time since the previous report counts when it was playing then, even if this report is the pause.
      if (lastTick) owed += Math.min(30, (t - lastTick) / 1000);
      lastTick = info.playing ? t : 0;
      if (info.reason === "end") {
        await push("sync", info.duration || info.position, info.duration);
        await send.finished(itemId, info.duration).catch(() => undefined);
      } else if (info.reason === "pause" || info.reason === "seek" || (info.reason === "tick" && info.playing && t - lastSent >= everyMs)) {
        await push("sync", info.position, info.duration);
      }
    },
    async closed(position: number, duration: number): Promise<void> {
      await push("close", position, duration);
    },
  };
}

// ---- playback -------------------------------------------------------------------------------

interface ActiveBook {
  itemId: string;
  sessionId: string;
  handle: MediaHandle;
  chapters: Chapter[];
}
let active: ActiveBook | null = null;
export const activeBook = (): ActiveBook | null => active;

/** Seconds to start the next play of a book at, set when a person picks a chapter or bookmark before it is loaded. */
const startOverride = new Map<string, number>();
export function startBookAt(itemId: string, seconds: number): void {
  startOverride.set(itemId, seconds);
}

const sender: SyncSend = {
  sync: (sid, b) => serverApi<void>(`api/audiobooks/sessions/${encodeURIComponent(sid)}/sync`, sendJson("POST", b)),
  close: (sid, b) => serverApi<void>(`api/audiobooks/sessions/${encodeURIComponent(sid)}/close`, sendJson("POST", b)),
  finished: (id, duration) => serverApi<void>(`api/audiobooks/items/${encodeURIComponent(id)}/progress`, sendJson("PUT", { currentTime: duration, duration, isFinished: true })),
};

export async function resolveBook(itemId: string): Promise<MediaHandle> {
  const session = await serverApi<PlaySession>(`api/audiobooks/items/${encodeURIComponent(itemId)}/play`, sendJson("POST"));
  const override = startOverride.get(itemId);
  startOverride.delete(itemId);
  const sync = createSessionSync(session.sessionId, itemId, sender);
  const rate = readSpeed();
  const handle = createMediaHandle({
    segments: session.tracks.map((t) => ({ url: serverUrl(t.path)!, startOffset: t.startOffset, duration: t.durationSec })),
    totalDuration: session.durationSec,
    startAt: override ?? resumeAt(session.startTime),
    rate,
    onTick: (info) => void sync.onTick(info),
    onStop: (position) => {
      if (active?.handle === handle) {
        active = null;
        useAudiobooks.getState().setActive(null);
      }
      void sync.closed(position, session.durationSec);
    },
  });
  handle.onSleepChange((sleep) => useAudiobooks.getState().setSleep(sleep));
  active = { itemId, sessionId: session.sessionId, handle, chapters: session.chapters };
  useAudiobooks.getState().setActive({ itemId, chapters: session.chapters, rate });
  return handle;
}

// ---- the store -----------------------------------------------------------------------------

interface AudiobookState {
  status: Status | null;
  checking: boolean;
  busy: boolean;
  error: string | null;
  continueBooks: Book[];
  continueLoaded: boolean;
  /** What is being listened to right now. */
  current: { itemId: string; chapters: Chapter[]; rate: number } | null;
  sleep: SleepTimer | null;
  refreshStatus: () => Promise<void>;
  connect: (username: string, password: string) => Promise<boolean>;
  disconnect: () => Promise<void>;
  loadContinue: () => Promise<void>;
  setActive: (a: { itemId: string; chapters: Chapter[]; rate: number } | null) => void;
  setSleep: (s: SleepTimer | null) => void;
  setSpeed: (rate: number) => void;
  startSleep: (kind: { minutes: number } | "chapter" | null, position: number) => void;
  reset: () => void;
}

export const useAudiobooks = create<AudiobookState>((set, get) => ({
  status: null,
  checking: false,
  busy: false,
  error: null,
  continueBooks: [],
  continueLoaded: false,
  current: null,
  sleep: null,

  async refreshStatus() {
    set({ checking: true });
    try {
      const status = await serverApi<Status>("api/audiobooks/status");
      set({ status, error: null });
      if (status.connected) void get().loadContinue();
    } catch (e) {
      // A server without the plugin answers 404: nothing to connect to.
      set({ status: { configured: false, connected: false }, error: e instanceof ApiError && e.status === 404 ? null : describeError(e, "audiobooks") });
    } finally {
      set({ checking: false });
    }
  },

  async connect(username, password) {
    set({ busy: true, error: null });
    try {
      const status = await serverApi<Status>("api/audiobooks/connection", sendJson("PUT", { username: username.trim(), password }));
      set({ status, busy: false });
      void get().loadContinue();
      return true;
    } catch (e) {
      const wrong = e instanceof ApiError && e.status === 401;
      set({ busy: false, error: wrong ? "Audiobookshelf didn't accept that user name and password." : describeError(e, "audiobooks") });
      return false;
    }
  },

  async disconnect() {
    set({ busy: true, error: null });
    try {
      await serverApi<void>("api/audiobooks/connection", sendJson("DELETE"));
      set((s) => ({ busy: false, status: { configured: s.status?.configured ?? true, connected: false }, continueBooks: [], continueLoaded: false }));
    } catch (e) {
      set({ busy: false, error: describeError(e, "audiobooks") });
    }
  },

  async loadContinue() {
    try {
      const res = await serverApi<{ items: Book[] }>("api/audiobooks/continue");
      set({ continueBooks: res.items, continueLoaded: true });
    } catch (e) {
      if (e instanceof ApiError && e.code === "audiobooks_session_expired") set((s) => ({ status: { configured: true, connected: false, userName: s.status?.userName }, continueLoaded: true }));
      else set({ continueLoaded: true });
    }
  },

  setActive: (current) => set({ current, ...(current ? {} : { sleep: null }) }),
  setSleep: (sleep) => set({ sleep }),

  setSpeed(rate) {
    saveSpeed(rate);
    active?.handle.setRate(rate);
    set((s) => (s.current ? { current: { ...s.current, rate } } : {}));
  },

  startSleep(kind, position) {
    const handle = active?.handle;
    if (!handle) return;
    if (kind === null) return handle.setSleep(null);
    if (kind === "chapter") {
      const end = chapterEnd(active!.chapters, position);
      return handle.setSleep(end !== null ? { kind: "position", at: end } : { kind: "minutes", until: Date.now() + 30 * 60_000 });
    }
    handle.setSleep({ kind: "minutes", until: Date.now() + kind.minutes * 60_000 });
  },

  reset: () => set({ status: null, checking: false, busy: false, error: null, continueBooks: [], continueLoaded: false, current: null, sleep: null }),
}));

// ---- browsing --------------------------------------------------------------------------------

export async function fetchLibraries(): Promise<{ id: string; name: string }[]> {
  return (await serverApi<{ items: { id: string; name: string }[] }>("api/audiobooks/libraries")).items;
}

export async function fetchBooks(libraryId: string, opts: { q?: string; page?: number; limit?: number; sort?: string } = {}): Promise<{ items: Book[]; total: number; page: number }> {
  return serverApi(`api/audiobooks/libraries/${encodeURIComponent(libraryId)}/items${query({ q: opts.q, page: opts.page, limit: opts.limit ?? 36, sort: opts.sort })}`);
}

export async function fetchBook(id: string): Promise<Book> {
  return serverApi(`api/audiobooks/items/${encodeURIComponent(id)}`);
}

export async function fetchBookmarks(id: string): Promise<Bookmark[]> {
  return (await serverApi<{ items: Bookmark[] }>(`api/audiobooks/items/${encodeURIComponent(id)}/bookmarks`)).items;
}

export async function addBookmark(id: string, time: number, title: string): Promise<void> {
  await serverApi(`api/audiobooks/items/${encodeURIComponent(id)}/bookmarks`, sendJson("POST", { time, title }));
}

export async function removeBookmark(id: string, time: number): Promise<void> {
  await serverApi(`api/audiobooks/items/${encodeURIComponent(id)}/bookmarks/${Math.floor(time)}`, sendJson("DELETE"));
}

export async function getAdminAddress(): Promise<string | null> {
  return (await serverApi<{ serverUrl: string | null }>("api/audiobooks/admin")).serverUrl;
}

export async function saveAdminAddress(serverUrl: string | null): Promise<string | null> {
  return (await serverApi<{ serverUrl: string | null }>("api/audiobooks/admin", sendJson("PUT", { serverUrl }))).serverUrl;
}

export async function testAdminAddress(serverUrl: string): Promise<{ ok: boolean; message?: string }> {
  return serverApi("api/audiobooks/admin/test", sendJson("POST", { serverUrl }));
}