import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import { useServer } from "../../builtins/server/serverStore";
import type { PluginContext } from "../../types";
import { useRemote } from "./remoteStore";
import { createRemoteTarget } from "./target";
import type { RemoteDevice } from "./types";

const track = (id: string): Track => ({ id, title: id, artists: [{ id: "a", name: "A" }] });
const laptop: RemoteDevice = {
  id: "dev-laptop",
  name: "Laptop",
  kind: "desktop",
  online: true,
  lastSeen: 0,
  state: { track: track("t2"), isPlaying: true, position: 77, duration: 200, volume: 1, queue: [track("t1"), track("t2")], index: 1, updatedAt: 0 },
};

function setup(local: { isPlaying: boolean; position?: number }) {
  const api = vi.fn<(route: string, init?: RequestInit) => Promise<unknown>>(async (route) => {
    if (route === "api/remote-control/devices") return { devices: [laptop, { ...laptop, id: "dev-me", name: "Me" }, { ...laptop, id: "dev-off", online: false }] };
    return undefined;
  });
  useServer.setState({ api: api as never, url: "http://s", token: "t" });
  useRemote.setState({ deviceId: "dev-me", devices: [], selectedId: null });
  const state = { current: track("t2"), isPlaying: local.isPlaying, position: local.position ?? 12, duration: 200, volume: 1, queue: [track("t1"), track("t2"), track("t3")], index: 1 };
  const player = {
    getState: () => state,
    toggle: vi.fn(() => void (state.isPlaying = !state.isPlaying)),
    seek: vi.fn(),
    playTracks: vi.fn(async () => void (state.isPlaying = true)),
  };
  const ctx = { player } as unknown as PluginContext;
  return { api, player, state, target: createRemoteTarget(ctx) };
}

describe("Other Cadence devices output", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("lists only other players that are online", async () => {
    const { target } = setup({ isPlaying: true });
    expect(await target.listDevices()).toEqual([{ id: "dev-laptop", name: "Laptop" }]);
  });

  it("hands the queue and position to the other player and pauses this one", async () => {
    const { target, api, player } = setup({ isPlaying: true, position: 33 });
    await target.select("dev-laptop");
    const call = api.mock.calls.find(([route]) => String(route).endsWith("/command"))!;
    expect(call[0]).toBe("api/remote-control/devices/dev-laptop/command");
    const body = JSON.parse(call[1]!.body as string);
    expect(body.from).toBe("dev-me");
    expect(body.command).toMatchObject({ type: "queue.play", index: 1, position: 33, play: true });
    expect(body.command.tracks.map((t: Track) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(player.toggle).toHaveBeenCalledTimes(1);
    expect(useRemote.getState().selectedId).toBe("dev-laptop");
  });

  it("does not pause this device when it was not playing", async () => {
    const { target, player } = setup({ isPlaying: false });
    await target.select("dev-laptop");
    expect(player.toggle).not.toHaveBeenCalled();
  });

  it("refuses to hand over nothing, and explains when the device cannot be reached", async () => {
    const a = setup({ isPlaying: true });
    a.state.current = null as unknown as Track;
    await expect(a.target.select("dev-laptop")).rejects.toThrow(/Start something playing/);
    const b = setup({ isPlaying: true });
    b.api.mockImplementation(async () => {
      throw new Error("Request failed (409): device offline");
    });
    await expect(b.target.select("dev-laptop")).rejects.toThrow(/offline/);
    expect(b.player.toggle).not.toHaveBeenCalled();
  });

  it("choosing this device again pulls the queue back at the other player's position and stops it", async () => {
    const { target, api, player, state } = setup({ isPlaying: true });
    await target.select("dev-laptop");
    state.isPlaying = false;
    player.playTracks.mockClear();
    await target.select(null);
    const commands = api.mock.calls.filter(([route]) => String(route).endsWith("/command")).map(([, init]) => JSON.parse(init!.body as string).command.type);
    expect(commands).toContain("pause");
    expect(player.playTracks).toHaveBeenCalledWith([track("t1"), track("t2")], 1);
    expect(player.seek).toHaveBeenCalledWith(77);
    expect(player.toggle).toHaveBeenCalledTimes(1);
  });
});
