import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ serverApi: vi.fn(), created: [] as { opts: Record<string, any>; handle: Record<string, any> }[] }));
vi.mock("../_sourcekit/api", () => ({
  serverApi: h.serverApi,
  sendJson: (method: string, body?: unknown) => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  serverUrl: (p?: string) => (p ? `https://srv.example/${p}` : undefined),
  describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  query: (o: Record<string, unknown>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") qs.set(k, String(v));
    return qs.size ? `?${qs}` : "";
  },
}));
vi.mock("../_sourcekit/handle", () => ({
  createMediaHandle: (opts: Record<string, any>) => {
    const handle = { rate: opts.rate, setRate: vi.fn((r: number) => (handle.rate = r)), setSleep: vi.fn(), onSleepChange: vi.fn(), stop: vi.fn() };
    h.created.push({ opts, handle });
    return handle;
  },
}));
vi.mock("../../builtins/server/serverStore", () => {
  class ApiError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string) {
      super(message);
    }
  }
  return { ApiError, useServer: Object.assign(() => null, { getState: () => ({ token: "tok", user: { username: "a", isAdmin: true }, url: "https://srv.example" }), subscribe: vi.fn() }) };
});

import { ApiError } from "../../builtins/server/serverStore";
import type { AudioSource, PluginContext } from "../../types";
import audiobooksPlugin from "./index";
import {
  activeBook,
  bookIdOf,
  bookToTrack,
  chapterAt,
  chapterEnd,
  createSessionSync,
  readSpeed,
  resolveBook,
  resumeAt,
  saveSpeed,
  startBookAt,
  useAudiobooks,
  type Book,
  type Chapter,
  type SyncSend,
} from "./audiobookStore";

const chapters: Chapter[] = [
  { index: 0, start: 0, end: 600, title: "One" },
  { index: 1, start: 600, end: 1800, title: "Two" },
  { index: 2, start: 1800, end: 3600, title: "Three" },
];
const book: Book = { id: "li_1", title: "The Book", author: "Ann Author", series: "Saga #1", durationSec: 3600, cover: "api/audiobooks/cover/li_1?u=1", progress: { currentTime: 900, progress: 0.25, isFinished: false, lastUpdate: 1 } };

beforeEach(() => {
  h.serverApi.mockReset();
  h.created.length = 0;
  useAudiobooks.getState().reset();
  localStorage.clear();
});

describe("books", () => {
  it("maps to tracks: whole book, author as artist, series as album", () => {
    expect(bookToTrack(book)).toMatchObject({ id: "audiobook:li_1", title: "The Book", album: "Saga #1", durationSec: 3600, source: "audiobooks" });
    expect(bookToTrack(book).artists[0].name).toBe("Ann Author");
    expect(bookToTrack({ ...book, author: undefined, series: undefined }).artists[0].name).toBe("Unknown author");
    expect(bookIdOf({ id: "audiobook:x" })).toBe("x");
    expect(bookIdOf({ id: "podcast:x" })).toBeNull();
  });

  it("finds chapters", () => {
    expect(chapterAt(chapters, 0)?.title).toBe("One");
    expect(chapterAt(chapters, 599.9)?.title).toBe("One");
    expect(chapterAt(chapters, 600)?.title).toBe("Two");
    expect(chapterAt(chapters, 99999)?.title).toBe("Three");
    expect(chapterAt([], 5)).toBeNull();
    expect(chapterEnd(chapters, 700)).toBe(1800);
    expect(chapterEnd([], 700)).toBeNull();
  });

  it("steps back a little when resuming, but not at the very start", () => {
    expect(resumeAt(0)).toBe(0);
    expect(resumeAt(20)).toBe(20);
    expect(resumeAt(900)).toBe(890);
  });

  it("remembers the speed", () => {
    expect(readSpeed()).toBe(1);
    saveSpeed(1.5);
    expect(readSpeed()).toBe(1.5);
    localStorage.setItem("cadence.audiobooks.speed", "99");
    expect(readSpeed()).toBe(1);
  });
});

describe("reporting to Audiobookshelf", () => {
  function setup() {
    let t = 1_000_000;
    const calls: { kind: string; body: Record<string, unknown> }[] = [];
    const send: SyncSend = {
      sync: vi.fn(async (_sid, body) => void calls.push({ kind: "sync", body })),
      close: vi.fn(async (_sid, body) => void calls.push({ kind: "close", body })),
      finished: vi.fn(async () => undefined),
    };
    const sync = createSessionSync("s1", "li_1", send, { everyMs: 15_000, now: () => t });
    return { sync, send, calls, advance: (ms: number) => (t += ms) };
  }
  const tick = (position: number, reason: "tick" | "pause" | "seek" | "play" | "end" = "tick", playing = true) => ({ position, duration: 3600, playing, reason });

  it("syncs every 15 seconds while playing and counts the real time listened", async () => {
    const { sync, calls, advance } = setup();
    await sync.onTick(tick(10, "play"));
    for (let i = 0; i < 4; i++) {
      advance(4000);
      await sync.onTick(tick(10 + 4 * (i + 1)));
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ currentTime: 26, timeListened: 16, duration: 3600, itemId: "li_1" });
  });

  it("syncs on pause and seek, and does not count paused time", async () => {
    const { sync, calls, advance } = setup();
    await sync.onTick(tick(0, "play"));
    advance(10_000);
    await sync.onTick(tick(10, "pause", false));
    advance(600_000);
    await sync.onTick(tick(10, "play", true));
    advance(5000);
    await sync.onTick(tick(500, "seek", true));
    expect(calls.map((c) => c.body.timeListened)).toEqual([10, 5]);
  });

  it("a failed report keeps its listened time for the next", async () => {
    const { sync, send, calls, advance } = setup();
    (send.sync as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("offline"));
    await sync.onTick(tick(0, "play"));
    advance(8000);
    await sync.onTick(tick(8, "pause", false));
    advance(1000);
    await sync.onTick(tick(8, "play"));
    advance(7000);
    await sync.onTick(tick(15, "pause", false));
    expect(calls).toHaveLength(1);
    expect(calls[0].body.timeListened).toBe(15);
  });

  it("closing sends the final position; reaching the end marks the book finished", async () => {
    const { sync, send, calls } = setup();
    await sync.closed(1234, 3600);
    expect(calls[0]).toMatchObject({ kind: "close", body: { currentTime: 1234 } });
    await sync.onTick(tick(3600, "end", false));
    expect(send.finished).toHaveBeenCalledWith("li_1", 3600);
  });
});

describe("playing a book", () => {
  const session = {
    sessionId: "play-1",
    durationSec: 3600,
    startTime: 1234,
    chapters,
    tracks: [
      { index: 0, startOffset: 0, durationSec: 1800, path: "api/audiobooks/stream/play-1/0?u=1" },
      { index: 1, startOffset: 1800, durationSec: 1800, path: "api/audiobooks/stream/play-1/1?u=1" },
    ],
  };

  it("opens every file at the saved place with the remembered speed", async () => {
    saveSpeed(1.25);
    h.serverApi.mockResolvedValue(session);
    await resolveBook("li_1");
    const { opts } = h.created[0];
    expect(h.serverApi).toHaveBeenCalledWith("api/audiobooks/items/li_1/play", { method: "POST" });
    expect(opts.segments).toEqual([
      { url: "https://srv.example/api/audiobooks/stream/play-1/0?u=1", startOffset: 0, duration: 1800 },
      { url: "https://srv.example/api/audiobooks/stream/play-1/1?u=1", startOffset: 1800, duration: 1800 },
    ]);
    expect(opts.startAt).toBe(1224);
    expect(opts.rate).toBe(1.25);
    expect(opts.totalDuration).toBe(3600);
    expect(useAudiobooks.getState().current).toMatchObject({ itemId: "li_1", rate: 1.25 });
  });

  it("starts where a chapter or bookmark was picked, once", async () => {
    h.serverApi.mockResolvedValue(session);
    startBookAt("li_1", 600);
    await resolveBook("li_1");
    expect(h.created[0].opts.startAt).toBe(600);
    await resolveBook("li_1");
    expect(h.created[1].opts.startAt).toBe(1224);
  });

  it("closes the session with the final position and clears what's playing", async () => {
    h.serverApi.mockResolvedValue(session);
    await resolveBook("li_1");
    h.created[0].opts.onStop(2000);
    expect(activeBook()).toBeNull();
    expect(useAudiobooks.getState().current).toBeNull();
    await vi.waitFor(() => expect(h.serverApi).toHaveBeenCalledWith("api/audiobooks/sessions/play-1/close", expect.objectContaining({ method: "POST" })));
    const body = JSON.parse((h.serverApi.mock.calls.at(-1) as unknown as [string, { body: string }])[1].body);
    expect(body).toMatchObject({ currentTime: 2000, itemId: "li_1", duration: 3600 });
  });

  it("speed changes apply to the playing book and are remembered", async () => {
    h.serverApi.mockResolvedValue(session);
    await resolveBook("li_1");
    useAudiobooks.getState().setSpeed(1.75);
    expect(h.created[0].handle.setRate).toHaveBeenCalledWith(1.75);
    expect(readSpeed()).toBe(1.75);
    expect(useAudiobooks.getState().current?.rate).toBe(1.75);
  });

  it("sleep timer: minutes, end of chapter, and cancel", async () => {
    h.serverApi.mockResolvedValue(session);
    await resolveBook("li_1");
    const { handle } = h.created[0];
    useAudiobooks.getState().startSleep({ minutes: 20 }, 0);
    const timer = handle.setSleep.mock.calls[0][0];
    expect(timer.kind).toBe("minutes");
    expect(timer.until - Date.now()).toBeGreaterThan(19 * 60_000);
    useAudiobooks.getState().startSleep("chapter", 700);
    expect(handle.setSleep).toHaveBeenLastCalledWith({ kind: "position", at: 1800 });
    useAudiobooks.getState().startSleep(null, 0);
    expect(handle.setSleep).toHaveBeenLastCalledWith(null);
    // the handle's own changes reach the store
    const onChange = handle.onSleepChange.mock.calls[0][0];
    onChange({ kind: "minutes", until: 5 });
    expect(useAudiobooks.getState().sleep).toEqual({ kind: "minutes", until: 5 });
  });
});

describe("sign-in state", () => {
  it("a wrong password gets a plain message; success stores the status", async () => {
    h.serverApi.mockRejectedValueOnce(new ApiError("Request failed (401)", 401, "audiobooks_invalid_credentials"));
    expect(await useAudiobooks.getState().connect("ann", "bad")).toBe(false);
    expect(useAudiobooks.getState().error).toMatch(/didn't accept/);
    h.serverApi.mockResolvedValue({ configured: true, connected: true, userName: "ann" });
    expect(await useAudiobooks.getState().connect(" ann ", "good")).toBe(true);
    expect(h.serverApi).toHaveBeenCalledWith("api/audiobooks/connection", { method: "PUT", body: JSON.stringify({ username: "ann", password: "good" }) });
    expect(useAudiobooks.getState().status?.connected).toBe(true);
  });

  it("a server without the plugin reads as 'not set up', without an error", async () => {
    h.serverApi.mockRejectedValue(new ApiError("Request failed (404)", 404));
    await useAudiobooks.getState().refreshStatus();
    expect(useAudiobooks.getState().status).toEqual({ configured: false, connected: false });
    expect(useAudiobooks.getState().error).toBeNull();
  });

  it("signing out clears what was loaded", async () => {
    useAudiobooks.setState({ status: { configured: true, connected: true }, continueBooks: [book] });
    h.serverApi.mockResolvedValue(undefined);
    await useAudiobooks.getState().disconnect();
    expect(useAudiobooks.getState().status?.connected).toBe(false);
    expect(useAudiobooks.getState().continueBooks).toEqual([]);
  });
});

describe("plugin", () => {
  it("registers a source that only takes audiobook tracks", async () => {
    let source!: AudioSource;
    const commands: string[] = [];
    const ctx = {
      player: { getState: () => ({ position: 0 }), seek: vi.fn() },
      registerSidebarItem: vi.fn(),
      registerSettingsPanel: vi.fn(),
      registerAudioSource: (s: AudioSource) => (source = s),
      registerLibrarySource: vi.fn(),
      registerCommand: (c: { id: string }) => commands.push(c.id),
    } as unknown as PluginContext;
    h.serverApi.mockResolvedValue({ configured: false, connected: false });
    void audiobooksPlugin.activate(ctx);
    expect(await source.resolve({ id: "radio:x", title: "", artists: [] })).toBeNull();
    expect(commands).toEqual(["audiobooks.sleep30", "audiobooks.back"]);
    expect(audiobooksPlugin.manifest.builtin).toBeFalsy();
    expect(audiobooksPlugin.manifest.capabilities).toContain("player.control");
  });
});