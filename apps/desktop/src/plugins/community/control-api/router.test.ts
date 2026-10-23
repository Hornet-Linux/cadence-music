import { describe, expect, it, vi } from "vitest";
import type { PlayerApi } from "../../types";
import { transportActions } from "../_desktop/transport";
import type { Track } from "@/shared/types";
import { buildState, createRouter } from "./router";

const track: Track = { id: "t1", title: "Song", artists: [{ id: "a", name: "Artist" }], album: "Album" };

function fakePlayer(over: Partial<ReturnType<PlayerApi["getState"]>> = {}) {
  const state = { current: track, isPlaying: false, position: 12.4, duration: 200.2, volume: 0.5, queue: [track], index: 0, ...over };
  const calls: string[] = [];
  const player: PlayerApi = {
    getState: () => state,
    toggle: () => {
      calls.push("toggle");
      state.isPlaying = !state.isPlaying;
    },
    next: async () => void calls.push("next"),
    previous: async () => void calls.push("previous"),
    seek: (s) => void calls.push(`seek:${s}`),
    setVolume: (v) => {
      calls.push(`volume:${v}`);
      state.volume = v;
    },
    playTracks: async () => undefined,
    enqueue: () => undefined,
  };
  return { player, state, calls };
}

function setup(allowOthers = false, over = {}) {
  const f = fakePlayer(over);
  const liked = new Set<string>();
  const actions = transportActions({
    player: f.player,
    toggleLike: (t) => void (liked.has(t.id) ? liked.delete(t.id) : liked.add(t.id)),
    isLiked: (id) => liked.has(id),
  });
  const external = vi.fn();
  const registry = [
    { id: "other.sleep", title: "Sleep", run: external },
    { id: "cadence.media-keys.next", title: "Next", run: () => undefined },
  ];
  const router = createRouter({ actions, registry: () => registry, allowOthers: () => allowOthers });
  return { ...f, liked, router, external };
}

describe("command routing", () => {
  it("play only starts playback that is stopped, pause only stops what is playing", async () => {
    const t = setup();
    await t.router.run("pause", {});
    expect(t.calls).toEqual([]);
    await t.router.run("play", {});
    await t.router.run("play", {});
    expect(t.calls).toEqual(["toggle"]);
    await t.router.run("pause", {});
    expect(t.calls).toEqual(["toggle", "toggle"]);
  });

  it("does nothing for play-pause when there is no track", async () => {
    const t = setup(false, { current: null });
    await t.router.run("play-pause", {});
    expect(t.calls).toEqual([]);
  });

  it("skips tracks", async () => {
    const t = setup();
    await t.router.run("next", {});
    await t.router.run("previous", {});
    expect(t.calls).toEqual(["next", "previous"]);
  });

  it("steps and sets volume, clamped, accepting 0-1 or a percentage", async () => {
    const t = setup();
    await t.router.run("volume-up", {});
    await t.router.run("volume", { value: 0.2 });
    await t.router.run("volume", { value: 85 });
    await t.router.run("volume", { value: "30" });
    await t.router.run("volume-down", {});
    expect(t.calls).toEqual(["volume:0.55", "volume:0.2", "volume:0.85", "volume:0.3", "volume:0.25"]);
    await expect(t.router.run("volume", { value: "loud" })).rejects.toThrow(/between 0 and 1/);
    await expect(t.router.run("volume", {})).rejects.toThrow();
    t.state.volume = 0.98;
    await t.router.run("volume-up", {});
    expect(t.calls.at(-1)).toBe("volume:1");
  });

  it("seeks to a number of seconds and rejects nonsense", async () => {
    const t = setup();
    await t.router.run("seek", { seconds: 30 });
    await t.router.run("seek", { seconds: "45" });
    expect(t.calls).toEqual(["seek:30", "seek:45"]);
    await expect(t.router.run("seek", { seconds: -1 })).rejects.toThrow();
    await expect(t.router.run("seek", {})).rejects.toThrow();
  });

  it("likes, unlikes and toggles the current track, and refuses with nothing playing", async () => {
    const t = setup();
    await t.router.run("like", {});
    await t.router.run("like", {});
    expect([...t.liked]).toEqual(["t1"]);
    await t.router.run("toggle-like", {});
    expect([...t.liked]).toEqual([]);
    await t.router.run("unlike", {});
    expect([...t.liked]).toEqual([]);
    const none = setup(false, { current: null });
    await expect(none.router.run("like", {})).rejects.toThrow("nothing_playing");
  });

  it("answers unknown commands with unknown_command", async () => {
    const t = setup();
    await expect(t.router.run("rm-rf", {})).rejects.toThrow("unknown_command");
    await expect(t.router.run("toString", {})).rejects.toThrow("unknown_command");
    await expect(t.router.run("__proto__", {})).rejects.toThrow("unknown_command");
  });

  it("only reaches other plugins' commands when allowed", async () => {
    const off = setup(false);
    await expect(off.router.run("other.sleep", {})).rejects.toThrow("unknown_command");
    expect(off.router.names()).not.toContain("other.sleep");
    const on = setup(true);
    await on.router.run("other.sleep", {});
    expect(on.external).toHaveBeenCalledOnce();
    expect(on.router.names()).toContain("other.sleep");
    expect(on.router.names()).not.toContain("cadence.media-keys.next");
  });
});

describe("state snapshot", () => {
  it("summarises playback for remotes", () => {
    const t = setup();
    expect(buildState(t.state, true)).toEqual({
      playing: false,
      track: { id: "t1", title: "Song", artists: ["Artist"], album: "Album", artwork: null, source: null },
      positionSec: 12,
      durationSec: 200,
      volume: 0.5,
      liked: true,
      queueLength: 1,
    });
    expect(buildState({ ...t.state, current: null }, false).track).toBeNull();
  });
});