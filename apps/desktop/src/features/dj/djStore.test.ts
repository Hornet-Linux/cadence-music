import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import type { DjTrack } from "./resolve";

const track = (id: string): Track => ({ id: `spotify:track:${id}`, title: id, artists: [{ id: "a", name: "A" }] });
const set = (...ids: string[]): DjTrack[] => ids.map((id) => ({ track: track(id), intro: `intro ${id}` }));

const planDjSet = vi.fn();
const speakIntro = vi.fn();
vi.mock("./voice", () => ({ speakIntro: (t: string) => speakIntro(t), stopSpeaking: () => undefined }));
vi.mock("./dj", () => ({ planDjSet: (...args: unknown[]) => planDjSet(...args) }));
vi.mock("./tasteProfile", () => ({
  buildTasteProfile: async () => ({ topArtists: ["A"], genres: [], topTracks: [], recentTracks: [] }),
  isEmptyProfile: () => false,
}));

const player = { queue: [] as Track[], index: 0, current: null as Track | null };
const listeners: ((s: typeof player) => void)[] = [];
vi.mock("@/player/playerStore", () => {
  const api = {
    getState: () => ({
      ...player,
      playQueue: async (q: Track[], i: number) => api.setState({ queue: q, index: i, current: q[i] }),
      next: async () => api.setState({ index: player.index + 1, current: player.queue[player.index + 1] }),
    }),
    setState: (patch: Partial<typeof player> | ((s: typeof player) => Partial<typeof player>)) => {
      Object.assign(player, typeof patch === "function" ? patch(player) : patch);
      listeners.forEach((l) => l(player));
    },
    subscribe: (l: (s: typeof player) => void) => listeners.push(l),
  };
  return { usePlayer: api };
});
const spotify = { status: "signed-in" };
vi.mock("@/plugins/builtins/spotify/spotifyStore", () => ({
  useSpotify: { getState: () => ({ status: spotify.status, tracks: [] }) },
}));

const { useDj } = await import("./djStore");
const { useJellyfin } = await import("@/plugins/builtins/jellyfin/jellyfinStore");
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("useDj", () => {
  beforeEach(() => {
    useDj.getState().stop();
    useDj.setState({ history: [], intros: {}, error: null });
    Object.assign(player, { queue: [], index: 0, current: null });
    planDjSet.mockReset();
    speakIntro.mockReset();
  });

  it("starts playing the first set", async () => {
    planDjSet.mockResolvedValueOnce(set("1", "2", "3", "4", "5")).mockResolvedValue([]);
    await useDj.getState().start();
    expect(useDj.getState().status).toBe("on");
    expect(player.queue.map((t) => t.title)).toEqual(["1", "2", "3", "4", "5"]);
    expect(useDj.getState().intros["spotify:track:1"]).toBe("intro 1");
    expect(speakIntro).toHaveBeenCalledWith("intro 1");
  });

  it("stays quiet when spoken intros are off", async () => {
    useDj.setState({ voice: false });
    planDjSet.mockResolvedValueOnce(set("1", "2", "3", "4", "5"));
    await useDj.getState().start();
    expect(speakIntro).not.toHaveBeenCalled();
    useDj.setState({ voice: true });
  });

  it("shows the error and stays off when the first set fails", async () => {
    planDjSet.mockRejectedValue(new Error("Ollama isn't running"));
    await useDj.getState().start();
    expect(useDj.getState()).toMatchObject({ status: "idle", error: "Ollama isn't running" });
  });

  it("refills when the queue runs low", async () => {
    planDjSet.mockResolvedValueOnce(set("1", "2", "3", "4")).mockResolvedValueOnce(set("5", "6"));
    await useDj.getState().start();
    useDj.setState({ status: "on" });
    player.index = 1;
    (await import("@/player/playerStore")).usePlayer.setState({ current: player.queue[1] });
    await flush();
    expect(player.queue.map((t) => t.title)).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("switch it up replaces upcoming tracks", async () => {
    planDjSet.mockResolvedValueOnce(set("1", "2", "3", "4", "5", "6")).mockResolvedValueOnce(set("x", "y", "z", "w"));
    await useDj.getState().start();
    await useDj.getState().switchUp();
    expect(player.queue.map((t) => t.title)).toEqual(["1", "x", "y", "z", "w"]);
    expect(player.current?.title).toBe("x");
    expect(planDjSet.mock.calls[1][2]).toMatchObject({ switchUp: true });
  });

  it("turns off when the user plays something else", async () => {
    planDjSet.mockResolvedValueOnce(set("1", "2", "3", "4", "5"));
    await useDj.getState().start();
    (await import("@/player/playerStore")).usePlayer.setState({ current: track("other") });
    expect(useDj.getState().status).toBe("idle");
  });
});

describe("setup check", () => {
  it("points to Settings when Ollama isn't running", async () => {
    planDjSet.mockReset();
    vi.stubGlobal("host", { llm: { status: async () => ({ available: false, models: [] }) } });
    await useDj.getState().start();
    expect(useDj.getState()).toMatchObject({ status: "idle", needsSetup: true });
    expect(useDj.getState().error).toContain("Ollama");
    expect(planDjSet).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("music source", () => {
  const realTaste = useJellyfin.getState().taste;
  const taste = vi.fn(async () => ({ topArtists: ["J"], genres: [], topTracks: [], recentTracks: [] }));

  beforeEach(() => {
    useDj.getState().stop();
    useDj.setState({ history: [], intros: {}, error: null, sourcePref: "auto" });
    Object.assign(player, { queue: [], index: 0, current: null });
    planDjSet.mockReset();
    planDjSet.mockResolvedValue(set("1", "2", "3", "4", "5"));
    spotify.status = "signed-in";
    useJellyfin.setState({ status: null, taste });
    localStorage.clear();
  });
  afterEach(() => {
    useJellyfin.setState({ status: null, taste: realTaste });
    useDj.getState().stop();
  });

  const connectJellyfin = () => useJellyfin.setState({ status: { configured: true, connected: true } });
  const sourceUsed = () => (planDjSet.mock.calls[0][3] as { id: string }).id;

  it("plays from Spotify when only Spotify is connected", async () => {
    await useDj.getState().start();
    expect(sourceUsed()).toBe("spotify");
    expect(useDj.getState().source).toBe("spotify");
    expect(taste).not.toHaveBeenCalled();
  });

  it("plays from Jellyfin when only Jellyfin is connected", async () => {
    spotify.status = "signed-out";
    connectJellyfin();
    await useDj.getState().start();
    expect(sourceUsed()).toBe("jellyfin");
    expect(useDj.getState().source).toBe("jellyfin");
    expect(planDjSet.mock.calls[0][1]).toMatchObject({ topArtists: ["J"] });
    expect(useDj.getState().status).toBe("on");
  });

  it("auto prefers Jellyfin when both are connected; an explicit choice wins", async () => {
    connectJellyfin();
    await useDj.getState().start();
    expect(sourceUsed()).toBe("jellyfin");

    useDj.getState().stop();
    planDjSet.mockClear();
    useDj.getState().setSourcePref("spotify");
    await useDj.getState().start();
    expect(sourceUsed()).toBe("spotify");
    expect(localStorage.getItem("dj:source")).toBe("spotify");
  });

  it("asks to connect the right service", async () => {
    spotify.status = "signed-out";
    await useDj.getState().start();
    expect(useDj.getState().error).toBe("Connect Spotify or Jellyfin to use the DJ.");

    useDj.setState({ sourcePref: "jellyfin", error: null });
    await useDj.getState().start();
    expect(useDj.getState().error).toContain("Connect Jellyfin");
    expect(planDjSet).not.toHaveBeenCalled();
  });
});
