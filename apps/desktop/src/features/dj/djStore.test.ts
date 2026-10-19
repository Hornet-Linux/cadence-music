import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import type { DjTrack } from "./resolve";

const track = (id: string): Track => ({ id: `spotify:track:${id}`, title: id, artists: [{ id: "a", name: "A" }] });
const set = (...ids: string[]): DjTrack[] => ids.map((id) => ({ track: track(id), intro: `intro ${id}` }));

const planDjSet = vi.fn();
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
vi.mock("@/plugins/builtins/spotify/spotifyStore", () => ({
  useSpotify: { getState: () => ({ status: "signed-in", tracks: [] }) },
}));

const { useDj } = await import("./djStore");
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("useDj", () => {
  beforeEach(() => {
    useDj.getState().stop();
    useDj.setState({ history: [], intros: {}, error: null });
    Object.assign(player, { queue: [], index: 0, current: null });
    planDjSet.mockReset();
  });

  it("starts playing the first set", async () => {
    planDjSet.mockResolvedValueOnce(set("1", "2", "3", "4", "5")).mockResolvedValue([]);
    await useDj.getState().start();
    expect(useDj.getState().status).toBe("on");
    expect(player.queue.map((t) => t.title)).toEqual(["1", "2", "3", "4", "5"]);
    expect(useDj.getState().intros["spotify:track:1"]).toBe("intro 1");
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
