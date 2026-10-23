import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ serverApi: vi.fn(), created: [] as { opts: Record<string, unknown>; handle: Record<string, unknown> }[] }));
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
  createMediaHandle: (opts: Record<string, unknown>) => {
    let rate = (opts.rate as number) ?? 1;
    const handle = { get rate() { return rate; }, setRate: vi.fn((r: number) => { rate = r; }), stop: vi.fn() };
    h.created.push({ opts, handle });
    return handle;
  },
}));
vi.mock("../../builtins/server/serverStore", () => ({
  useServer: Object.assign(() => null, { getState: () => ({ token: "tok", user: { username: "a", isAdmin: false }, url: "https://srv.example" }), subscribe: vi.fn() }),
}));

import type { AudioSource, Capability, PluginContext, SettingsContribution } from "../../types";
import podcastsPlugin from "./index";
import { describeImport, readOpmlFile } from "./opml";
import {
  activePlayback,
  connectQueue,
  createProgressReporter,
  episodeIdOf,
  episodeToTrack,
  queueFollowing,
  resolveEpisode,
  startPosition,
  stateOf,
  usePodcasts,
  type Episode,
} from "./podcastStore";

const ep = (over: Partial<Episode> = {}): Episode => ({
  id: "a".repeat(20),
  feedId: "f".repeat(16),
  title: "Episode One",
  description: "",
  durationSec: 1800,
  publishedAt: 1_700_000_000_000,
  hasChapters: false,
  feedTitle: "The Show",
  author: "Host",
  image: "api/podcasts/image?t=x",
  position: 0,
  played: false,
  progressAt: null,
  ...over,
});

beforeEach(() => {
  h.serverApi.mockReset();
  h.created.length = 0;
  usePodcasts.getState().reset();
});

describe("tracks", () => {
  it("maps an episode to a track, with the show as artist and album", () => {
    expect(episodeToTrack(ep())).toMatchObject({ id: `podcast:${"a".repeat(20)}`, title: "Episode One", album: "The Show", durationSec: 1800, source: "podcasts" });
    expect(episodeToTrack(ep()).artists).toEqual([{ id: "f".repeat(16), name: "The Show" }]);
    expect(episodeToTrack(ep()).artwork).toBe("https://srv.example/api/podcasts/image?t=x");
    expect(episodeToTrack(ep({ durationSec: 0 })).durationSec).toBeUndefined();
    expect(episodeIdOf({ id: "podcast:xyz" })).toBe("xyz");
    expect(episodeIdOf({ id: "radio:xyz" })).toBeNull();
  });
});

describe("where to resume", () => {
  const now = 10_000_000_000;
  it("starts from the top when finished or barely started", () => {
    expect(startPosition({ position: 900, played: true, progressAt: now - 1000 }, now)).toBe(0);
    expect(startPosition({ position: 4, played: false, progressAt: now - 1000 }, now)).toBe(0);
  });
  it("steps back a little after a break, more after a longer one", () => {
    expect(startPosition({ position: 900, played: false, progressAt: now - 5_000 }, now)).toBe(900);
    expect(startPosition({ position: 900, played: false, progressAt: now - 120_000 }, now)).toBe(897);
    expect(startPosition({ position: 900, played: false, progressAt: now - 20 * 60_000 }, now)).toBe(892);
    expect(startPosition({ position: 900, played: false, progressAt: null }, now)).toBe(885);
    expect(startPosition({ position: 12, played: false, progressAt: null }, now)).toBe(0);
  });
});

describe("progress reporting", () => {
  function setup() {
    let t = 1_000_000;
    const send = vi.fn(async () => undefined);
    const r = createProgressReporter(send, { everyMs: 15_000, now: () => t });
    return { r, send, advance: (ms: number) => (t += ms) };
  }
  const tick = (position: number, reason: "tick" | "pause" | "seek" | "play" | "end" = "tick", playing = true) => ({ position, duration: 1800, playing, reason });

  it("reports every 15 seconds while playing, not on every tick", async () => {
    const { r, send, advance } = setup();
    await r.onTick("e1", tick(1));
    advance(5000);
    await r.onTick("e1", tick(6));
    expect(send).toHaveBeenCalledTimes(1);
    advance(11_000);
    await r.onTick("e1", tick(17));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith("e1", { position: 17, duration: 1800 });
  });

  it("reports on pause and seek, and marks finished episodes played", async () => {
    const { r, send } = setup();
    await r.onTick("e1", tick(100, "pause", false));
    expect(send).toHaveBeenLastCalledWith("e1", { position: 100, duration: 1800 });
    await r.onTick("e1", tick(500, "seek"));
    expect(send).toHaveBeenLastCalledWith("e1", { position: 500, duration: 1800 });
    await r.onTick("e1", tick(1800, "end", false));
    expect(send).toHaveBeenLastCalledWith("e1", { position: 1800, duration: 1800, played: true });
  });

  it("reports the final position when playback is released", async () => {
    const { r, send } = setup();
    await r.stopped("e1", 321, 1800);
    expect(send).toHaveBeenLastCalledWith("e1", { position: 321, duration: 1800 });
  });

  it("a failed report is retried with the next one, stamped with the time it was true", async () => {
    const { r, send, advance } = setup();
    send.mockRejectedValueOnce(new Error("offline"));
    await r.onTick("e1", tick(50, "pause", false));
    expect(r.hasPending).toBe(true);
    advance(60_000);
    await r.onTick("e1", tick(80, "pause", false));
    const body = (send.mock.calls.at(-1) as unknown as [string, Record<string, unknown>])[1];
    expect(body.position).toBe(80);
    expect(typeof body.updatedAt).toBe("number");
    expect(r.hasPending).toBe(false);
  });
});

describe("playing an episode", () => {
  const detail = (over: Record<string, unknown> = {}) => ({ ...ep({ position: 600, progressAt: Date.now() - 3600_000 * 5 }), speed: 1.5, autoQueue: true, ...over });
  function api(d = detail()) {
    h.serverApi.mockImplementation(async (route: string) => {
      if (route.endsWith("/stream-url")) return { path: "api/podcasts/audio/x?u=1" };
      if (route.includes("/next")) return { items: [ep({ id: "b".repeat(20), title: "Two" }), ep({ id: "c".repeat(20), title: "Three" })] };
      if (route.includes("/progress")) return { position: 1 };
      return d;
    });
  }

  it("opens the stream at the saved place and the show's speed", async () => {
    api();
    const handle = await resolveEpisode("a".repeat(20));
    const { opts } = h.created[0];
    expect(opts.startAt).toBe(585);
    expect(opts.rate).toBe(1.5);
    expect((opts.segments as { url: string }[])[0].url).toBe("https://srv.example/api/podcasts/audio/x?u=1");
    expect(opts.totalDuration).toBe(1800);
    expect(activePlayback()?.handle).toBe(handle);
    expect(usePodcasts.getState().rate).toBe(1.5);
  });

  it("queues the following episodes without doubling up what's queued", async () => {
    api();
    const added: string[] = [];
    connectQueue((t) => added.push(t.title), () => [`podcast:${"b".repeat(20)}`]);
    await resolveEpisode("a".repeat(20));
    await vi.waitFor(() => expect(added).toEqual(["Three"]));
  });

  it("does not queue when auto-queue is off for the show", async () => {
    api(detail({ autoQueue: false }) as never);
    const added: string[] = [];
    connectQueue((t) => added.push(t.title), () => []);
    await resolveEpisode("a".repeat(20));
    await new Promise((r) => setTimeout(r, 10));
    expect(added).toEqual([]);
    await queueFollowing("a".repeat(20), "f".repeat(16), 1);
    expect(added.length).toBe(2);
  });

  it("changing speed applies it, remembers it for the show, and rolls back if the server refuses", async () => {
    api();
    const handle = (await resolveEpisode("a".repeat(20))) as unknown as { rate: number; setRate: ReturnType<typeof vi.fn> };
    usePodcasts.setState({ shows: [{ id: "f".repeat(16), title: "The Show", author: "", description: "", subscribed: true, speed: 1.5 }] });
    h.serverApi.mockResolvedValue({});
    await usePodcasts.getState().changeSpeed(2);
    expect(handle.setRate).toHaveBeenCalledWith(2);
    expect(h.serverApi).toHaveBeenLastCalledWith(`api/podcasts/subscriptions/${"f".repeat(16)}`, { method: "PATCH", body: JSON.stringify({ speed: 2 }) });
    expect(usePodcasts.getState().shows[0].speed).toBe(2);
    h.serverApi.mockRejectedValue(new Error("no"));
    await usePodcasts.getState().setShowSpeed("f".repeat(16), 1);
    expect(usePodcasts.getState().shows[0].speed).toBe(2);
  });

  it("releasing the handle clears the active playback and reports where it stopped", async () => {
    api();
    await resolveEpisode("a".repeat(20));
    (h.created[0].opts.onStop as (p: number) => void)(642);
    expect(activePlayback()).toBeNull();
    await vi.waitFor(() => expect(h.serverApi).toHaveBeenCalledWith(`api/podcasts/episodes/${"a".repeat(20)}/progress`, { method: "PUT", body: JSON.stringify({ position: 642, duration: 1800 }) }));
  });
});

describe("store", () => {
  it("played toggles apply at once and revert on failure", async () => {
    h.serverApi.mockResolvedValue({});
    await usePodcasts.getState().setPlayed("e1", true);
    expect(usePodcasts.getState().progress.e1).toEqual({ position: 0, played: true });
    h.serverApi.mockRejectedValue(new Error("nope"));
    await usePodcasts.getState().setPlayed("e2", true);
    expect(usePodcasts.getState().progress.e2).toBeUndefined();
    expect(usePodcasts.getState().error).toBe("nope");
    expect(stateOf(ep({ position: 5 }), { x: { position: 1, played: true } })).toEqual({ position: 5, played: false });
    expect(stateOf(ep(), { [ep().id]: { position: 9, played: true } })).toEqual({ position: 9, played: true });
  });

  it("subscribing reloads the lists; a bad feed leaves a readable error", async () => {
    h.serverApi.mockImplementation(async (route: string) => (route === "api/podcasts/subscriptions" ? { items: [] } : { items: [] }));
    h.serverApi.mockImplementationOnce(async () => ({ id: "f".repeat(16), title: "S", subscribed: true }));
    const show = await usePodcasts.getState().subscribe("https://x.example/rss");
    expect(show?.title).toBe("S");
    expect(usePodcasts.getState().showsLoaded).toBe(true);
    h.serverApi.mockReset();
    h.serverApi.mockRejectedValueOnce(new Error("That address doesn't look like a podcast feed"));
    expect(await usePodcasts.getState().subscribe("https://x.example/nope")).toBeNull();
    expect(usePodcasts.getState().error).toMatch(/podcast feed/);
  });

  it("unsubscribing removes the show at once", async () => {
    usePodcasts.setState({ shows: [{ id: "f".repeat(16), title: "S", author: "", description: "", subscribed: true }] });
    h.serverApi.mockResolvedValue({ items: [] });
    const p = usePodcasts.getState().unsubscribe("f".repeat(16));
    expect(usePodcasts.getState().shows).toEqual([]);
    await p;
  });
});

describe("OPML helpers", () => {
  it("describes imports in plain words", () => {
    expect(describeImport({ found: 3, added: 3, alreadySubscribed: 0 })).toMatch(/^Added 3 shows/);
    expect(describeImport({ found: 1, added: 1, alreadySubscribed: 0 })).toMatch(/^Added 1 show\./);
    expect(describeImport({ found: 4, added: 2, alreadySubscribed: 2 })).toMatch(/\(2 you already had\)/);
    expect(describeImport({ found: 2, added: 0, alreadySubscribed: 2 })).toBe("You already follow all 2 of those shows.");
  });
  it("refuses huge files before reading them", async () => {
    await expect(readOpmlFile({ size: 5_000_000, text: async () => "x" })).rejects.toThrow(/too big/);
    expect(await readOpmlFile({ size: 10, text: async () => "<opml/>" })).toBe("<opml/>");
  });
});

describe("plugin", () => {
  it("is optional, declares what it uses, and registers its contributions", () => {
    expect(podcastsPlugin.manifest.builtin).toBeFalsy();
    const caps = podcastsPlugin.manifest.capabilities;
    for (const c of ["source.audio", "source.library", "ui.sidebar", "ui.settings", "commands", "player.queue"] as Capability[]) expect(caps).toContain(c);
    const sources: AudioSource[] = [];
    const commands: string[] = [];
    const panels: SettingsContribution[] = [];
    const ctx = {
      player: { enqueue: vi.fn(), getState: () => ({ queue: [], current: null, position: 0 }), seek: vi.fn() },
      registerSidebarItem: vi.fn(),
      registerSettingsPanel: (p: SettingsContribution) => panels.push(p),
      registerHomeWidget: vi.fn(),
      registerAudioSource: (s: AudioSource) => sources.push(s),
      registerLibrarySource: vi.fn(),
      registerCommand: (c: { id: string }) => commands.push(c.id),
    } as unknown as PluginContext;
    void podcastsPlugin.activate(ctx);
    expect(commands).toEqual(["podcasts.faster", "podcasts.slower", "podcasts.back", "podcasts.forward"]);
    expect(panels[0].id).toBe("podcasts");
    expect(sources).toHaveLength(1);
  });

  it("ignores tracks from other sources", async () => {
    let source!: AudioSource;
    const ctx = {
      player: { enqueue: vi.fn(), getState: () => ({ queue: [] }) },
      registerSidebarItem: vi.fn(),
      registerSettingsPanel: vi.fn(),
      registerHomeWidget: vi.fn(),
      registerAudioSource: (s: AudioSource) => (source = s),
      registerLibrarySource: vi.fn(),
      registerCommand: vi.fn(),
    } as unknown as PluginContext;
    void podcastsPlugin.activate(ctx);
    expect(await source.resolve({ id: "radio:x", title: "", artists: [] })).toBeNull();
  });
});