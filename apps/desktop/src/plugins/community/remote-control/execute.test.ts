import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePlayer } from "@/player/playerStore";
import type { PlayerApi } from "../../types";
import type { Track } from "@/shared/types";
import { executeCommand } from "./execute";

const track = (id: string): Track => ({ id, title: id, artists: [{ id: "a", name: "A" }] });

function fakePlayer(isPlaying = false) {
  const state = { current: track("t"), isPlaying, position: 0, duration: 100, volume: 1, queue: [] as Track[], index: 0 };
  const api = {
    getState: () => state,
    toggle: vi.fn(() => void (state.isPlaying = !state.isPlaying)),
    next: vi.fn(async () => undefined),
    previous: vi.fn(async () => undefined),
    seek: vi.fn(),
    setVolume: vi.fn(),
    playTracks: vi.fn(async () => void (state.isPlaying = true)),
    enqueue: vi.fn(),
  };
  return { api: api as unknown as PlayerApi & typeof api, state };
}

describe("executeCommand", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("play and pause only toggle when the state differs", async () => {
    const p = fakePlayer(false);
    await executeCommand(p.api, { type: "pause" });
    expect(p.api.toggle).not.toHaveBeenCalled();
    await executeCommand(p.api, { type: "play" });
    expect(p.api.toggle).toHaveBeenCalledTimes(1);
    await executeCommand(p.api, { type: "play" });
    expect(p.api.toggle).toHaveBeenCalledTimes(1);
    await executeCommand(p.api, { type: "pause" });
    expect(p.api.toggle).toHaveBeenCalledTimes(2);
  });

  it("passes transport commands through", async () => {
    const p = fakePlayer();
    await executeCommand(p.api, { type: "next" });
    await executeCommand(p.api, { type: "previous" });
    await executeCommand(p.api, { type: "seek", position: 42 });
    await executeCommand(p.api, { type: "volume", volume: 0.3 });
    await executeCommand(p.api, { type: "toggle" });
    expect(p.api.next).toHaveBeenCalled();
    expect(p.api.previous).toHaveBeenCalled();
    expect(p.api.seek).toHaveBeenCalledWith(42);
    expect(p.api.setVolume).toHaveBeenCalledWith(0.3);
    expect(p.api.toggle).toHaveBeenCalled();
  });

  it("queue.play starts the queue at the position and can leave it paused", async () => {
    const p = fakePlayer();
    await executeCommand(p.api, { type: "queue.play", tracks: [track("a"), track("b")], index: 1, position: 30, play: false });
    expect(p.api.playTracks).toHaveBeenCalledWith([track("a"), track("b")], 1);
    expect(p.api.seek).toHaveBeenCalledWith(30);
    expect(p.api.toggle).toHaveBeenCalledTimes(1);
    expect(p.state.isPlaying).toBe(false);
  });

  it("queue.add and queue.jump use the queue", async () => {
    const p = fakePlayer();
    const jump = vi.spyOn(usePlayer.getState(), "jumpTo").mockResolvedValue(undefined);
    await executeCommand(p.api, { type: "queue.add", track: track("x") });
    expect(p.api.enqueue).toHaveBeenCalledWith(track("x"));
    await executeCommand(p.api, { type: "queue.jump", index: 3 });
    expect(jump).toHaveBeenCalledWith(3);
  });

  it("ignores junk from the network", async () => {
    const p = fakePlayer();
    await executeCommand(p.api, null);
    await executeCommand(p.api, "play");
    await executeCommand(p.api, { type: "queue.play", tracks: [], index: 0 });
    await executeCommand(p.api, { type: "seek", position: "soon" });
    await executeCommand(p.api, { type: "wat" });
    expect(p.api.playTracks).not.toHaveBeenCalled();
    expect(p.api.seek).not.toHaveBeenCalled();
    expect(p.api.toggle).not.toHaveBeenCalled();
  });
});
