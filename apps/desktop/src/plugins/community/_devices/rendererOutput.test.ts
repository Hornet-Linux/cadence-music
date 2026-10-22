import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlayer } from "@/player/playerStore";
import type { Track } from "@/shared/types";
import { ApiError } from "../../builtins/server/serverStore";
import type { PlaybackEvent, PluginContext } from "../../types";
import type { DeviceStatus, RendererApi } from "./deviceApi";
import { hasSession, createRendererTarget } from "./rendererOutput";
import { useOutput } from "./outputState";

const track = (id: string, title = id): Track => ({ id, title, artists: [{ id: "a", name: "Artist" }], album: "Album", durationSec: 200 });

function fakeApi() {
  return {
    list: vi.fn(async () => ({ devices: [{ id: "d1", name: "Kitchen", kind: "sonos" }] })),
    play: vi.fn(async () => ({ ok: true })),
    pause: vi.fn(async () => ({ ok: true })),
    resume: vi.fn(async () => ({ ok: true })),
    stop: vi.fn(async () => ({ ok: true })),
    seek: vi.fn(async () => ({ ok: true })),
    setVolume: vi.fn(async () => ({ ok: true })),
    status: vi.fn(async (): Promise<DeviceStatus> => ({ state: "playing", positionSec: 5 })),
    addManual: vi.fn(),
    removeManual: vi.fn(),
    getConfig: vi.fn(),
    setConfig: vi.fn(),
  };
}

function setup() {
  const api = fakeApi();
  let listener: (e: PlaybackEvent) => void = () => undefined;
  const player = { toggle: vi.fn(), seek: vi.fn() };
  const ctx = {
    onPlayback: (l: (e: PlaybackEvent) => void) => {
      listener = l;
      return () => undefined;
    },
    player,
  } as unknown as PluginContext;
  const target = createRendererTarget(ctx, { id: "t.dlna", label: "DLNA", prefix: "dlna", api: api as unknown as RendererApi, pollMs: 1000 });
  return { api, player, target, emit: (e: PlaybackEvent) => listener(e) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
  usePlayer.setState({ current: track("server:one"), isPlaying: true, position: 12, duration: 200, volume: 0.8, muted: false, queue: [track("server:one")], index: 0 });
  useOutput.setState({ active: null, error: null, busy: false });
});

afterEach(async () => {
  vi.useRealTimers();
});

describe("renderer output (DLNA, Chromecast)", () => {
  it("sends the current track and position to the device and silences this device", async () => {
    const { api, target } = setup();
    await target.select("d1");
    expect(api.play).toHaveBeenCalledWith("d1", expect.objectContaining({ trackId: "server:one", positionSec: 12, autoplay: true, title: "server:one", artist: "Artist", album: "Album" }));
    expect(usePlayer.getState().muted).toBe(true);
    expect(hasSession("t.dlna")).toBe(true);
    await target.select(null);
  });

  it("does not claim the output when the device refuses the first track", async () => {
    const { api, target } = setup();
    api.play.mockRejectedValue(new ApiError("Request failed (502): The device did not respond.", 502));
    await expect(target.select("d1")).rejects.toThrow("The device did not respond.");
    expect(usePlayer.getState().muted).toBe(false);
    expect(hasSession("t.dlna")).toBe(false);
  });

  it("choosing this device stops the speaker and gives the sound back", async () => {
    const { api, target } = setup();
    await target.select("d1");
    await target.select(null);
    expect(api.stop).toHaveBeenCalledWith("d1");
    expect(usePlayer.getState().muted).toBe(false);
    expect(hasSession("t.dlna")).toBe(false);
  });

  it("leaves this device muted afterwards if the person had muted it themselves", async () => {
    usePlayer.setState({ muted: true });
    const { target } = setup();
    await target.select("d1");
    await target.select(null);
    expect(usePlayer.getState().muted).toBe(true);
  });

  it("follows track changes, play, pause and seeks", async () => {
    const { api, target, emit } = setup();
    await target.select("d1");
    api.play.mockClear();
    usePlayer.setState({ current: track("server:two", "Two"), position: 0 });
    emit({ kind: "track", track: track("server:two", "Two") });
    expect(api.play).toHaveBeenCalledWith("d1", expect.objectContaining({ trackId: "server:two", positionSec: 0, autoplay: true }));
    emit({ kind: "pause", track: track("server:two"), position: 3 });
    emit({ kind: "play", track: track("server:two"), position: 3 });
    emit({ kind: "seek", track: track("server:two"), position: 90, duration: 200 });
    expect(api.pause).toHaveBeenCalledWith("d1");
    expect(api.resume).toHaveBeenCalledWith("d1");
    expect(api.seek).toHaveBeenCalledWith("d1", 90);
    await target.select(null);
  });

  it("forwards volume changes once they settle", async () => {
    const { api, target } = setup();
    await target.select("d1");
    usePlayer.setState({ volume: 0.3 });
    usePlayer.setState({ volume: 0.35 });
    expect(api.setVolume).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(api.setVolume).toHaveBeenCalledTimes(1);
    expect(api.setVolume).toHaveBeenCalledWith("d1", 0.35);
    await target.select(null);
  });
});

describe("renderer output edge cases", () => {
  it("plays here instead when the device cannot take a track, and returns to the device for the next one", async () => {
    const { api, target, emit } = setup();
    await target.select("d1");
    api.play.mockRejectedValueOnce(new ApiError("Request failed (422): Only tracks from your Cadence server or Jellyfin can be played on a device.", 422));
    emit({ kind: "track", track: track("spotify:abc") });
    await vi.advanceTimersByTimeAsync(0);
    expect(usePlayer.getState().muted).toBe(false);
    expect(useOutput.getState().error).toMatch(/Only tracks from your Cadence server/);
    expect(hasSession("t.dlna")).toBe(true);
    emit({ kind: "track", track: track("server:next") });
    await vi.advanceTimersByTimeAsync(0);
    expect(usePlayer.getState().muted).toBe(true);
    expect(useOutput.getState().error).toBeNull();
    await target.select(null);
  });

  it("pauses here when the speaker itself was paused, after two polls agree", async () => {
    const { api, target, player } = setup();
    await target.select("d1");
    await vi.advanceTimersByTimeAsync(4000);
    api.status.mockResolvedValue({ state: "paused", positionSec: 20 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(player.toggle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(player.toggle).toHaveBeenCalledTimes(1);
    await target.select(null);
  });

  it("pulls the silent local clock back in line when it drifts from the device", async () => {
    const { api, target, player } = setup();
    await target.select("d1");
    await vi.advanceTimersByTimeAsync(4000);
    api.status.mockResolvedValue({ state: "playing", positionSec: 40 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(player.seek).toHaveBeenCalledWith(40);
    await target.select(null);
  });

  it("gives up and plays here again after the device stops answering", async () => {
    const { api, target } = setup();
    await target.select("d1");
    api.status.mockRejectedValue(new Error("down"));
    await vi.advanceTimersByTimeAsync(3500);
    expect(hasSession("t.dlna")).toBe(false);
    expect(usePlayer.getState().muted).toBe(false);
    expect(useOutput.getState().error).toMatch(/Lost contact with Kitchen/);
  });

  it("lists devices by name and turns a server failure into a readable message", async () => {
    const { api, target } = setup();
    expect(await target.listDevices()).toEqual([{ id: "d1", name: "Kitchen" }]);
    expect(api.list).toHaveBeenCalledWith(true);
    api.list.mockRejectedValue(new ApiError("Request failed (502): The device did not respond.", 502));
    await expect(target.listDevices()).rejects.toThrow("The device did not respond.");
  });
});
