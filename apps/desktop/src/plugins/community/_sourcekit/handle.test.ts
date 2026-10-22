import { describe, expect, it, vi } from "vitest";
import { createMediaHandle, fadeFactor, segmentIndexFor, type AudioLike, type HandleOptions, type HlsModule } from "./handle";

class FakeAudio implements AudioLike {
  src = "";
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  volume = 1;
  playbackRate = 1;
  playCalls = 0;
  canPlayType?: (type: string) => string;
  private listeners = new Map<string, Set<() => void>>();
  async play() {
    this.paused = false;
    this.playCalls++;
  }
  pause() {
    this.paused = true;
  }
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  addEventListener(type: string, l: () => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(l);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, l: () => void) {
    this.listeners.get(type)?.delete(l);
  }
  fire(type: string) {
    for (const l of [...(this.listeners.get(type) ?? [])]) l();
  }
  listenerCount() {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
  }
}

const SEGMENTS = [
  { url: "a.mp3", startOffset: 0, duration: 100 },
  { url: "b.mp3", startOffset: 100, duration: 100 },
  { url: "c.mp3", startOffset: 200, duration: 50 },
];

function make(extra: Partial<HandleOptions> = {}) {
  const audio = new FakeAudio();
  const handle = createMediaHandle({ segments: SEGMENTS, createAudio: () => audio, ...extra });
  const events: Record<string, unknown>[] = [];
  handle.subscribe((e) => events.push({ ...e }));
  return { audio, handle, events };
}

describe("segments", () => {
  it("finds the file that contains a position", () => {
    expect(segmentIndexFor(SEGMENTS, 0)).toBe(0);
    expect(segmentIndexFor(SEGMENTS, 99.9)).toBe(0);
    expect(segmentIndexFor(SEGMENTS, 100)).toBe(1);
    expect(segmentIndexFor(SEGMENTS, 249)).toBe(2);
    expect(segmentIndexFor(SEGMENTS, 9999)).toBe(2);
    expect(segmentIndexFor([], 5)).toBe(0);
  });

  it("starts in the right file at the right place", () => {
    const { audio, handle } = make({ startAt: 130 });
    expect(audio.src).toBe("b.mp3");
    audio.fire("loadedmetadata");
    expect(audio.currentTime).toBe(30);
    expect(handle.position()).toBe(130);
  });

  it("reports whole-recording position and duration", () => {
    const { audio, events } = make({ startAt: 100 });
    audio.fire("loadedmetadata");
    audio.currentTime = 12.5;
    audio.fire("timeupdate");
    expect(events.at(-1)).toMatchObject({ position: 112.5, duration: 250 });
  });

  it("seeks within a file by moving the playhead, and across files by switching", async () => {
    const { audio, handle } = make();
    await handle.play();
    await handle.seek(40);
    expect(audio.src).toBe("a.mp3");
    expect(audio.currentTime).toBe(40);
    await handle.seek(215);
    expect(audio.src).toBe("c.mp3");
    audio.fire("loadedmetadata");
    expect(audio.currentTime).toBe(15);
    expect(audio.playCalls).toBeGreaterThanOrEqual(2);
    await handle.seek(-5);
    expect(audio.src).toBe("a.mp3");
    await handle.seek(Number.NaN);
    expect(audio.src).toBe("a.mp3");
  });

  it("plays the next file when one ends, and ends after the last", async () => {
    const { audio, events } = make();
    audio.fire("ended");
    await Promise.resolve();
    await Promise.resolve();
    expect(audio.src).toBe("b.mp3");
    expect(events.some((e) => e.ended)).toBe(false);
    audio.fire("ended");
    await Promise.resolve();
    await Promise.resolve();
    expect(audio.src).toBe("c.mp3");
    audio.fire("ended");
    expect(events.at(-1)).toMatchObject({ ended: true, playing: false });
  });
});

describe("speed and volume", () => {
  it("applies the starting speed and later changes, ignoring nonsense", () => {
    const { audio, handle } = make({ rate: 1.5 });
    expect(audio.playbackRate).toBe(1.5);
    handle.setRate(2);
    expect(audio.playbackRate).toBe(2);
    expect(handle.rate).toBe(2);
    handle.setRate(0);
    handle.setRate(40);
    handle.setRate(Number.NaN);
    expect(audio.playbackRate).toBe(2);
  });

  it("passes the host volume through", async () => {
    const { audio, handle } = make();
    await handle.setVolume(0.4);
    expect(audio.volume).toBeCloseTo(0.4);
  });
});

describe("sleep timer", () => {
  it("fades over the last seconds, then pauses and clears itself", () => {
    let t = 1_000_000;
    const { audio, handle, events } = make({ now: () => t });
    void handle.setVolume(0.8);
    const changes: unknown[] = [];
    handle.onSleepChange((s) => changes.push(s));
    handle.setSleep({ kind: "minutes", until: t + 60_000 });
    audio.paused = false;
    audio.fire("timeupdate");
    expect(audio.volume).toBeCloseTo(0.8);
    t += 50_000; // 10 s left of a 20 s fade
    audio.fire("timeupdate");
    expect(audio.volume).toBeCloseTo(0.4, 1);
    t += 10_001;
    audio.fire("timeupdate");
    expect(audio.paused).toBe(true);
    expect(handle.sleep).toBeNull();
    expect(audio.volume).toBeCloseTo(0.8);
    expect(events.some((e) => e.playing === false)).toBe(true);
    expect(changes.length).toBe(2);
  });

  it("can wait for a position (end of chapter), accounting for speed", () => {
    const { audio, handle } = make({ rate: 2 });
    handle.setSleep({ kind: "position", at: 60 });
    audio.paused = false;
    audio.currentTime = 20;
    audio.fire("timeupdate");
    expect(audio.paused).toBe(false);
    expect(audio.volume).toBe(1); // 20 s of audio left at 2x is 20 s: fade not begun
    audio.currentTime = 50; // 10 s of audio left = 5 s real time
    audio.fire("timeupdate");
    expect(audio.volume).toBeLessThan(0.5);
    audio.currentTime = 60;
    audio.fire("timeupdate");
    expect(audio.paused).toBe(true);
  });

  it("cancelling restores the volume", () => {
    const { audio, handle } = make({ now: () => 0 });
    handle.setSleep({ kind: "minutes", until: 5000 });
    audio.fire("timeupdate");
    expect(audio.volume).toBeLessThan(1);
    handle.setSleep(null);
    expect(audio.volume).toBe(1);
  });

  it("fade curve", () => {
    expect(fadeFactor(60)).toBe(1);
    expect(fadeFactor(20)).toBe(1);
    expect(fadeFactor(10)).toBe(0.5);
    expect(fadeFactor(0)).toBe(0.03);
    expect(fadeFactor(-4)).toBe(0.03);
  });
});

describe("stopping", () => {
  it("reports where listening stopped, releases the element and ignores late events", async () => {
    const onStop = vi.fn();
    const { audio, handle, events } = make({ startAt: 105, onStop });
    audio.fire("loadedmetadata");
    audio.currentTime = 9;
    await handle.stop();
    expect(onStop).toHaveBeenCalledWith(109);
    expect(audio.src).toBe("");
    expect(audio.listenerCount()).toBe(0);
    const before = events.length;
    audio.fire("timeupdate");
    expect(events.length).toBe(before);
    await handle.stop();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("emits ticks for play, pause, seek and ends", async () => {
    const ticks: string[] = [];
    const { handle } = make({ onTick: (t) => ticks.push(t.reason) });
    await handle.play();
    await handle.seek(10);
    await handle.pause();
    expect(ticks).toEqual(["play", "seek", "pause"]);
  });

  it("surfaces element errors", () => {
    const onError = vi.fn();
    const { audio, events } = make({ onError });
    audio.fire("error");
    expect(onError).toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ playing: false });
  });
});

describe("live streams", () => {
  it("uses the browser's own HLS support when it has it", async () => {
    const audio = new FakeAudio();
    audio.canPlayType = () => "maybe";
    const handle = createMediaHandle({ segments: [{ url: "live.m3u8", startOffset: 0, duration: 0 }], hls: true, createAudio: () => audio });
    await handle.play();
    expect(audio.src).toBe("live.m3u8");
  });

  it("falls back to hls.js, waits for the manifest, and tears it down", async () => {
    const audio = new FakeAudio();
    const handlers = new Map<string, (...a: unknown[]) => void>();
    const destroy = vi.fn();
    const instance = {
      loadSource: vi.fn(),
      attachMedia: vi.fn(),
      on: (e: string, h: (...a: unknown[]) => void) => handlers.set(e, h),
      destroy,
    };
    const mod: HlsModule = { isSupported: () => true, create: () => instance, events: { MANIFEST_PARSED: "m", ERROR: "e" } };
    const handle = createMediaHandle({ segments: [{ url: "live.m3u8", startOffset: 0, duration: 0 }], hls: true, createAudio: () => audio, loadHls: async () => mod });
    const playing = handle.play();
    await Promise.resolve();
    await Promise.resolve();
    expect(audio.playCalls).toBe(0);
    handlers.get("m")!();
    await playing;
    expect(instance.loadSource).toHaveBeenCalledWith("live.m3u8");
    expect(instance.attachMedia).toHaveBeenCalledWith(audio);
    expect(audio.playCalls).toBe(1);
    await handle.stop();
    expect(destroy).toHaveBeenCalled();
  });

  it("reports when HLS cannot be played at all", async () => {
    const onError = vi.fn();
    const handle = createMediaHandle({ segments: [{ url: "x", startOffset: 0, duration: 0 }], hls: true, createAudio: () => new FakeAudio(), loadHls: async () => null, onError });
    await expect(handle.play()).rejects.toThrow();
    expect(onError).toHaveBeenCalled();
  });
});