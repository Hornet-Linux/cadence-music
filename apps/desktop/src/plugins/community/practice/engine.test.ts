import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlayer } from "@/player/playerStore";
import { DEFAULT_TUNING, useTuning } from "@/player/tuning";
import type { PluginContext } from "@/plugins/types";
import type { Track } from "@/shared/types";
import practice from "./index";
import { attach, startEngine, stopEngine, usePractice } from "./engine";
import { noLoop } from "./loop";

const track = (id: string): Track => ({ id, title: id, artists: [{ id: "a", name: "A" }], durationSec: 200 });

/** A stand-in for the player handle plugins get: just the state and the calls the engine makes. */
function fakePlayer(initial: { position?: number; isPlaying?: boolean; current?: Track | null } = {}) {
  const state = {
    current: initial.current === undefined ? track("a") : initial.current,
    isPlaying: initial.isPlaying ?? true,
    position: initial.position ?? 10,
    duration: 200,
    volume: 0.5,
    queue: [] as Track[],
    index: 0,
  };
  const api = {
    getState: () => state,
    toggle: vi.fn(() => {
      state.isPlaying = !state.isPlaying;
    }),
    next: vi.fn(async () => undefined),
    previous: vi.fn(async () => undefined),
    seek: vi.fn((s: number) => {
      state.position = s;
    }),
    setVolume: vi.fn(),
    playTracks: vi.fn(async () => undefined),
    enqueue: vi.fn(),
  };
  return { state, api };
}

let nowPlaying: ((t: Track | null) => void) | null = null;
function start(player: ReturnType<typeof fakePlayer>) {
  nowPlaying = null;
  const unsubscribe = vi.fn();
  attach({
    player: player.api,
    onNowPlaying: (listener: (t: Track | null) => void) => {
      nowPlaying = listener;
      return unsubscribe;
    },
  } as unknown as Pick<PluginContext, "player" | "onNowPlaying">);
  startEngine();
  return unsubscribe;
}

beforeEach(() => {
  vi.useFakeTimers();
  useTuning.setState({ ...DEFAULT_TUNING });
  usePlayer.setState({ engine: "html" });
  usePractice.setState({ loop: noLoop, rate: 1, countingIn: false, countInEachLoop: false, bpm: 120, beats: 4 });
});

afterEach(() => {
  stopEngine();
  vi.useRealTimers();
});

describe("it only uses supported APIs", () => {
  it("does not touch the media element prototype", () => {
    const { play, pause } = HTMLMediaElement.prototype;
    const time = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
    start(fakePlayer());
    expect(HTMLMediaElement.prototype.play).toBe(play);
    expect(HTMLMediaElement.prototype.pause).toBe(pause);
    expect(Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime")).toEqual(time);
  });

  it("declares the capabilities for the player APIs it calls", () => {
    expect(practice.manifest.capabilities).toEqual(expect.arrayContaining(["player.read", "player.control"]));
  });
});

describe("looping", () => {
  it("jumps back to A just before B, with the player seek", () => {
    const p = fakePlayer({ position: 20 });
    start(p);
    usePractice.setState({ loop: { a: 12, b: 20.5, enabled: true } });
    p.state.position = 20.4; // within the look-ahead of B
    vi.advanceTimersByTime(60);
    expect(p.api.seek).toHaveBeenCalledWith(12);
    expect(p.api.next).not.toHaveBeenCalled();
  });

  it("does not jump while the playhead is nowhere near B, or while paused", () => {
    const p = fakePlayer({ position: 14 });
    start(p);
    usePractice.setState({ loop: { a: 12, b: 20.5, enabled: true } });
    vi.advanceTimersByTime(200);
    expect(p.api.seek).not.toHaveBeenCalled();
    p.state.position = 20.4;
    p.state.isPlaying = false;
    vi.advanceTimersByTime(200);
    expect(p.api.seek).not.toHaveBeenCalled();
  });

  it("holds the track while a loop is on so crossfade and gapless cannot move to the next song", () => {
    const p = fakePlayer({ position: 190 });
    start(p);
    expect(useTuning.getState().holdTrack).toBe(false);
    usePractice.setState({ loop: { a: 180, b: 197, enabled: true } });
    expect(useTuning.getState().holdTrack).toBe(true);
    expect(p.api.next).not.toHaveBeenCalled();
    // Turning the loop off lets the player plan its transitions again.
    usePractice.getState().toggleLoop();
    expect(useTuning.getState().holdTrack).toBe(false);
  });

  it("lets go when the person moves well past B, and holds again if they come back", () => {
    const p = fakePlayer({ position: 30 });
    start(p);
    usePractice.setState({ loop: { a: 12, b: 20, enabled: true } });
    vi.advanceTimersByTime(60);
    expect(useTuning.getState().holdTrack).toBe(false);
    p.state.position = 15;
    vi.advanceTimersByTime(60);
    expect(useTuning.getState().holdTrack).toBe(true);
  });

  it("does not hold anything for a vendor player (no crossfade there anyway)", () => {
    usePlayer.setState({ engine: "external" });
    const p = fakePlayer({ position: 10 });
    start(p);
    usePractice.setState({ loop: { a: 5, b: 20, enabled: true } });
    expect(useTuning.getState().holdTrack).toBe(false);
    // It still loops, but jumps earlier because Spotify reports its position about once a second.
    p.state.position = 19.4;
    vi.advanceTimersByTime(60);
    expect(p.api.seek).toHaveBeenCalledWith(5);
  });

  it("is cleared when the song changes", () => {
    const p = fakePlayer({ position: 15 });
    start(p);
    usePractice.setState({ loop: { a: 12, b: 20, enabled: true } });
    expect(useTuning.getState().holdTrack).toBe(true);
    nowPlaying?.(track("b"));
    p.state.current = track("b");
    expect(usePractice.getState().loop).toEqual(noLoop);
    expect(useTuning.getState().holdTrack).toBe(false);
  });
});

describe("slow-down", () => {
  it("sets the player's speed with the pitch kept, through the tuning settings", () => {
    start(fakePlayer());
    usePractice.getState().setRate(0.7);
    expect(useTuning.getState().rate).toBe(0.7);
    expect(useTuning.getState().preservePitch).toBe(true);
  });

  it("gives the speed back at 100% and when the song changes", () => {
    start(fakePlayer());
    usePractice.getState().setRate(0.7);
    usePractice.getState().setRate(1);
    expect(useTuning.getState().rate).toBe(1);

    usePractice.getState().setRate(0.8);
    expect(useTuning.getState().rate).toBe(0.8);
    nowPlaying?.(track("b"));
    expect(useTuning.getState().rate).toBe(1);
    expect(usePractice.getState().rate).toBe(1);
  });

  it("is cleared when the plugin is turned off", () => {
    const p = fakePlayer();
    const unsubscribe = start(p);
    usePractice.getState().setRate(0.6);
    usePractice.setState({ loop: { a: 1, b: 9, enabled: true } });
    stopEngine();
    expect(useTuning.getState().rate).toBe(1);
    expect(useTuning.getState().holdTrack).toBe(false);
    expect(usePractice.getState().rate).toBe(1);
    expect(usePractice.getState().loop).toEqual(noLoop);
    expect(unsubscribe).toHaveBeenCalled();
    // And nothing keeps polling afterwards.
    p.state.position = 8.95;
    vi.advanceTimersByTime(500);
    expect(p.api.seek).not.toHaveBeenCalled();
  });

  it("puts back a speed another plugin had set, and leaves a later change of theirs alone", () => {
    useTuning.getState().set({ rate: 1.25, preservePitch: false });
    start(fakePlayer());
    usePractice.getState().setRate(0.7);
    usePractice.getState().setRate(1);
    expect(useTuning.getState().rate).toBe(1.25);
    expect(useTuning.getState().preservePitch).toBe(false);

    usePractice.getState().setRate(0.7);
    useTuning.getState().set({ rate: 1.5 }); // the speed plugin took over
    nowPlaying?.(track("c"));
    expect(useTuning.getState().rate).toBe(1.5);
  });
});

describe("count-in", () => {
  it("pauses, seeks to A, clicks for the bar and then plays", async () => {
    const p = fakePlayer({ position: 50 });
    start(p);
    usePractice.setState({ loop: { a: 12, b: 20, enabled: true }, bpm: 120, beats: 4 });
    const done = usePractice.getState().countInAndPlay();
    expect(usePractice.getState().countingIn).toBe(true);
    expect(p.state.isPlaying).toBe(false);
    expect(p.api.seek).toHaveBeenCalledWith(12);
    await vi.advanceTimersByTimeAsync(2100);
    await done;
    expect(p.state.isPlaying).toBe(true);
    expect(usePractice.getState().countingIn).toBe(false);
  });

  it("counts in again on every repeat when asked", async () => {
    const p = fakePlayer({ position: 19 });
    start(p);
    usePractice.setState({ loop: { a: 12, b: 20, enabled: true }, countInEachLoop: true, bpm: 240, beats: 2 });
    p.state.position = 19.9;
    vi.advanceTimersByTime(60);
    expect(p.api.seek).toHaveBeenCalledWith(12);
    expect(usePractice.getState().countingIn).toBe(true);
    await vi.advanceTimersByTimeAsync(700);
    expect(p.state.isPlaying).toBe(true);
    expect(usePractice.getState().countingIn).toBe(false);
  });
});
