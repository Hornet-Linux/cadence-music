import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ serverApi: vi.fn() }));
vi.mock("../_sourcekit/api", () => ({
  serverApi: api.serverApi,
  sendJson: (method: string, body?: unknown) => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  serverUrl: (p?: string) => (p ? `https://srv.example/${p}` : undefined),
  describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("../../builtins/server/serverStore", () => ({
  useServer: Object.assign(() => null, { getState: () => ({ token: "tok", user: { username: "a" } }), subscribe: vi.fn() }),
}));

import type { Plugin, PluginContext, AudioSource, LibrarySource } from "../../types";
import radioPlugin from "./index";
import { announce, describeStation, fetchStations, stationIdOf, stationToTrack, useRadio, watchNowPlaying, type RadioStation } from "./radioStore";

const station = (over: Partial<RadioStation> = {}): RadioStation => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Jazz FM",
  country: "Norway",
  countryCode: "NO",
  language: "norwegian",
  tags: ["jazz", "chill"],
  codec: "MP3",
  bitrate: 128,
  hls: false,
  votes: 3,
  clicks: 4,
  favicon: "api/radio/image?t=x&u=1&exp=2&sig=s",
  ...over,
});

beforeEach(() => {
  // jsdom has no media pipeline.
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  api.serverApi.mockReset();
  useRadio.getState().reset();
});
afterEach(() => vi.useRealTimers());

describe("stations as tracks", () => {
  it("maps a station to a playable track with its logo and tag", () => {
    const t = stationToTrack(station());
    expect(t).toMatchObject({ id: "radio:11111111-1111-4111-8111-111111111111", title: "Jazz FM", source: "radio", album: "Internet radio" });
    expect(t.artwork).toBe("https://srv.example/api/radio/image?t=x&u=1&exp=2&sig=s");
    expect(t.artists[0].name).toBe("Norway · jazz");
    expect(stationToTrack(station({ country: "", tags: [], favicon: undefined })).artists[0].name).toBe("Internet radio");
  });
  it("tells radio tracks from others", () => {
    expect(stationIdOf({ id: "radio:abc" })).toBe("abc");
    expect(stationIdOf({ id: "server:abc" })).toBeNull();
  });
  it("describes a station briefly", () => {
    expect(describeStation(station())).toBe("Norway · MP3 128 kbps · jazz, chill");
    expect(describeStation(station({ hls: true, codec: "AAC", bitrate: 0, tags: [] }))).toBe("Norway · AAC · live HLS");
  });
});

describe("favourites", () => {
  it("load from the server", async () => {
    api.serverApi.mockResolvedValue({ items: [station()] });
    await useRadio.getState().loadFavourites();
    expect(useRadio.getState().favourites).toHaveLength(1);
    expect(useRadio.getState().favouritesLoaded).toBe(true);
    expect(api.serverApi).toHaveBeenCalledWith("api/radio/favourites");
  });

  it("add and remove apply at once and are sent to the server", async () => {
    api.serverApi.mockResolvedValue(undefined);
    const p = useRadio.getState().toggleFavourite(station());
    expect(useRadio.getState().favourites.map((s) => s.name)).toEqual(["Jazz FM"]);
    await p;
    expect(api.serverApi).toHaveBeenCalledWith("api/radio/favourites/11111111-1111-4111-8111-111111111111", { method: "PUT" });
    await useRadio.getState().toggleFavourite(station());
    expect(useRadio.getState().favourites).toEqual([]);
    expect(api.serverApi).toHaveBeenLastCalledWith("api/radio/favourites/11111111-1111-4111-8111-111111111111", { method: "DELETE" });
  });

  it("roll back when the server refuses", async () => {
    api.serverApi.mockRejectedValue(new Error("nope"));
    await useRadio.getState().toggleFavourite(station());
    expect(useRadio.getState().favourites).toEqual([]);
    expect(useRadio.getState().error).toBe("nope");
  });

  it("a load failure keeps what was there and says so", async () => {
    useRadio.setState({ favourites: [station()] });
    api.serverApi.mockRejectedValue(new Error("offline"));
    await useRadio.getState().loadFavourites();
    expect(useRadio.getState().favourites).toHaveLength(1);
    expect(useRadio.getState().error).toBe("offline");
  });
});

describe("browsing", () => {
  it("builds search queries and skips empty filters", async () => {
    api.serverApi.mockResolvedValue({ items: [], hasMore: false });
    await fetchStations({ mode: "search", name: "jazz", country: "NO", language: "", tag: "chill", offset: 30, limit: 30 });
    expect(api.serverApi).toHaveBeenCalledWith("api/radio/stations?name=jazz&country=NO&tag=chill&limit=30&offset=30");
    await fetchStations({ mode: "top", limit: 10 });
    expect(api.serverApi).toHaveBeenLastCalledWith("api/radio/top?limit=10");
    await fetchStations({ mode: "trending" });
    expect(api.serverApi).toHaveBeenLastCalledWith("api/radio/trending?limit=30");
  });
});

describe("now playing (ICY)", () => {
  it("asks at once, then on a timer, reporting only changes", async () => {
    vi.useFakeTimers();
    const titles = ["A - One", "A - One", null, "B - Two"];
    const fetchTitle = vi.fn(async () => titles.shift() ?? null);
    const seen: (string | null)[] = [];
    const stop = watchNowPlaying("s1", (t) => seen.push(t), { everyMs: 1000, fetchTitle });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["A - One"]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(seen).toEqual(["A - One", null, "B - Two"]);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchTitle).toHaveBeenCalledTimes(4);
  });

  it("a late answer after stopping is dropped, and failures are ignored", async () => {
    vi.useFakeTimers();
    let release: (t: string) => void = () => undefined;
    const fetchTitle = vi.fn(() => new Promise<string | null>((r) => (release = r)));
    const seen: (string | null)[] = [];
    const stop = watchNowPlaying("s1", (t) => seen.push(t), { fetchTitle });
    stop();
    release("late");
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([]);
    const failing = vi.fn(async () => {
      throw new Error("down");
    });
    const stop2 = watchNowPlaying("s1", (t) => seen.push(t), { fetchTitle: failing, everyMs: 500 });
    await vi.advanceTimersByTimeAsync(1600);
    expect(failing.mock.calls.length).toBeGreaterThan(1);
    expect(seen).toEqual([]);
    stop2();
  });

  it("puts the song on the lock screen, with the station as artist", () => {
    const session = { metadata: null as unknown };
    vi.stubGlobal("navigator", { mediaSession: session });
    vi.stubGlobal("MediaMetadata", class { constructor(public init: unknown) {} });
    announce(stationToTrack(station()), "Artist - Song");
    expect((session.metadata as { init: Record<string, unknown> }).init).toMatchObject({ title: "Artist - Song", artist: "Jazz FM" });
    announce(stationToTrack(station()), null);
    expect((session.metadata as { init: Record<string, unknown> }).init).toMatchObject({ title: "Jazz FM" });
    vi.unstubAllGlobals();
  });
});

describe("plugin", () => {
  function activate() {
    const sources: AudioSource[] = [];
    const libs: LibrarySource[] = [];
    const sidebar: string[] = [];
    let listener: ((t: unknown) => void) | null = null;
    const ctx = {
      registerSidebarItem: (i: { id: string }) => sidebar.push(i.id),
      registerAudioSource: (s: AudioSource) => sources.push(s),
      registerLibrarySource: (l: LibrarySource) => libs.push(l),
      onNowPlaying: (l: (t: unknown) => void) => {
        listener = l;
        return () => undefined;
      },
    } as unknown as PluginContext;
    void (radioPlugin as Plugin).activate(ctx);
    return { sources, libs, sidebar, nowPlaying: (t: unknown) => listener?.(t) };
  }

  it("declares only what it uses and is not built in", () => {
    expect(radioPlugin.manifest.id).toBe("cadence.radio");
    expect(radioPlugin.manifest.builtin).toBeFalsy();
    expect(radioPlugin.manifest.capabilities).toEqual(["source.audio", "source.library", "ui.sidebar", "player.read", "network.outbound"]);
  });

  it("plays ordinary streams in the shared player and ignores other tracks", async () => {
    const { sources, sidebar, libs } = activate();
    expect(sidebar).toEqual(["radio"]);
    expect(libs[0].id).toBe("radio");
    api.serverApi.mockResolvedValue({ path: "api/radio/stream/abc?u=1", hls: false });
    expect(await sources[0].resolve({ id: "radio:abc", title: "x", artists: [] })).toBe("https://srv.example/api/radio/stream/abc?u=1");
    expect(await sources[0].resolve({ id: "server:abc", title: "x", artists: [] })).toBeNull();
  });

  it("hands HLS stations a player of their own", async () => {
    const { sources } = activate();
    api.serverApi.mockResolvedValue({ path: "api/radio/stream/abc?u=1", hls: true });
    const resolved = await sources[0].resolve({ id: "radio:abc", title: "x", artists: [] });
    expect(typeof resolved).toBe("object");
    expect(typeof (resolved as { play: unknown }).play).toBe("function");
    await (resolved as { stop: () => Promise<void> }).stop();
  });

  it("follows the now-playing text while a station plays and clears it afterwards", async () => {
    vi.useFakeTimers();
    const { nowPlaying } = activate();
    api.serverApi.mockResolvedValue({ title: "Band - Tune" });
    nowPlaying(stationToTrack(station()));
    await vi.advanceTimersByTimeAsync(0);
    expect(useRadio.getState().nowPlaying).toEqual({ stationId: "11111111-1111-4111-8111-111111111111", title: "Band - Tune" });
    nowPlaying(null);
    expect(useRadio.getState().nowPlaying).toBeNull();
    const calls = api.serverApi.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.serverApi.mock.calls.length).toBe(calls);
  });
});