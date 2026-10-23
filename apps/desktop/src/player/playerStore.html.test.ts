import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlayer } from "./playerStore";
import { audioGraph, resetRouteCache } from "./audioGraph";
import { DEFAULT_TUNING, useTuning } from "./tuning";
import { FakeAudioContext, FakeNode } from "./fakeAudio";
import { emptyContributions, usePluginHost } from "@/plugins/host";
import type { AudioEffect, Plugin } from "@/plugins/types";
import type { Track } from "@/shared/types";

const track = (id: string, durationSec = 200): Track => ({ id, title: id, artists: [{ id: "a", name: "A" }], durationSec });

// What the fake media elements report. Every element shares one clock: enough for these tests.
const clock = { time: 0, duration: 200 };
let playSpy: ReturnType<typeof vi.spyOn>;
let pauseSpy: ReturnType<typeof vi.spyOn>;
const origin = "http://media.test";

const fx: AudioEffect & { nodes: FakeNode } = {
  id: "test.fx",
  label: "fx",
  nodes: new FakeNode("fx"),
  create: () => ({ input: fx.nodes as unknown as AudioNode, output: fx.nodes as unknown as AudioNode }),
};

const plainSource: Plugin = {
  manifest: { id: "test.plain", name: "Plain", version: "1.0.0", capabilities: ["source.audio"], apiRange: "^1.0.0" },
  activate(ctx) {
    ctx.registerAudioSource({
      id: "plain",
      label: "Plain",
      resolve: async (t) => (t.id.startsWith("sdk:") ? null : t.id.startsWith("same:") ? `/media/${t.id}.mp3` : `${origin}/${t.id}.mp3`),
    });
  },
};

const effectPlugin: Plugin = {
  manifest: { id: "test.fx", name: "Fx", version: "1.0.0", capabilities: ["audio.dsp"], apiRange: "^1.0.0" },
  activate(ctx) {
    ctx.registerAudioEffect(fx);
  },
};

/** The element that most recently started playing. */
const lastPlayed = () => playSpy.mock.contexts.at(-1) as HTMLAudioElement;
const srcOf = (el: HTMLAudioElement) => el.getAttribute("src");

beforeAll(() => {
  // A newly started element begins at 0, like a real one.
  playSpy = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {
    clock.time = 0;
  });
  pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockImplementation(() => clock.duration);
  vi.spyOn(HTMLMediaElement.prototype, "currentTime", "get").mockImplementation(() => clock.time);
  vi.spyOn(HTMLMediaElement.prototype, "currentTime", "set").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(() => false);
});

beforeEach(async () => {
  clock.time = 0;
  clock.duration = 200;
  playSpy.mockClear();
  pauseSpy.mockClear();
  resetRouteCache();
  useTuning.setState({ ...DEFAULT_TUNING });
  usePluginHost.setState({ plugins: [], contributions: emptyContributions() });
  usePluginHost.getState().register(plainSource);
  await usePluginHost.getState().setEnabled("test.plain", true);
  usePlayer.setState({ volume: 0.8, muted: false, duck: 1, shuffle: false, repeat: "off" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("plain audio playback", () => {
  it("plays a URL on an element that is not routed when there are no effects", async () => {
    await usePlayer.getState().playQueue([track("a")], 0);
    const el = lastPlayed();
    expect(srcOf(el)).toBe(`${origin}/a.mp3`);
    expect(el.crossOrigin).toBeNull();
    expect(el.volume).toBeCloseTo(0.8);
    expect(usePlayer.getState().isPlaying).toBe(true);
  });

  it("keeps volume, duck and mute on the element", async () => {
    await usePlayer.getState().playQueue([track("a")], 0);
    const el = lastPlayed();
    usePlayer.getState().setVolume(0.5);
    expect(el.volume).toBeCloseTo(0.5);
    usePlayer.getState().setDuck(0.5);
    expect(el.volume).toBeCloseTo(0.25);
    usePlayer.getState().toggleMute();
    expect(el.muted).toBe(true);
    usePlayer.getState().toggleMute();
    expect(el.muted).toBe(false);
    useTuning.getState().set({ masterGain: 0.5 });
    expect(el.volume).toBeCloseTo(0.125);
  });

  it("applies speed and pitch settings, also to the next track", async () => {
    await usePlayer.getState().playQueue([track("a"), track("b")], 0);
    useTuning.getState().set({ rate: 1.5, preservePitch: false });
    const el = lastPlayed();
    expect(el.playbackRate).toBe(1.5);
    expect(el.preservesPitch).toBe(false);
    await usePlayer.getState().next();
    const second = lastPlayed();
    expect(second.defaultPlaybackRate).toBe(1.5);
    expect(second.playbackRate).toBe(1.5);
  });

  it("stops at the end of the track when asked, then clears the request", async () => {
    await usePlayer.getState().playQueue([track("a"), track("b")], 0);
    useTuning.getState().set({ stopAfterTrack: true });
    lastPlayed().dispatchEvent(new Event("ended"));
    await Promise.resolve();
    expect(usePlayer.getState().isPlaying).toBe(false);
    expect(usePlayer.getState().current?.id).toBe("a");
    expect(useTuning.getState().stopAfterTrack).toBe(false);
  });

  it("advances to the next track when a track ends", async () => {
    await usePlayer.getState().playQueue([track("a"), track("b")], 0);
    lastPlayed().dispatchEvent(new Event("ended"));
    await vi.waitFor(() => expect(usePlayer.getState().current?.id).toBe("b"));
  });
});

describe("following the audio element", () => {
  const withPaused = (el: HTMLAudioElement, paused: boolean) =>
    Object.defineProperty(el, "paused", { value: paused, configurable: true });

  it("notices when the system pauses and resumes the element", async () => {
    await usePlayer.getState().playQueue([track("a")], 0);
    const el = lastPlayed();
    expect(usePlayer.getState().isPlaying).toBe(true);

    withPaused(el, true);
    el.dispatchEvent(new Event("pause"));
    expect(usePlayer.getState().isPlaying).toBe(false);

    // The lock-screen play button now starts playback again.
    usePlayer.getState().toggle();
    await vi.waitFor(() => expect(usePlayer.getState().isPlaying).toBe(true));

    withPaused(el, true);
    el.dispatchEvent(new Event("pause"));
    expect(usePlayer.getState().isPlaying).toBe(false);
    // Another app hands audio focus back and the browser resumes by itself.
    withPaused(el, false);
    el.dispatchEvent(new Event("play"));
    expect(usePlayer.getState().isPlaying).toBe(true);
    Reflect.deleteProperty(el, "paused");
  });

  it("ignores the pause that comes with reaching the end", async () => {
    await usePlayer.getState().playQueue([track("a"), track("b")], 0);
    const el = lastPlayed();
    Object.defineProperty(el, "ended", { value: true, configurable: true });
    el.dispatchEvent(new Event("pause"));
    expect(usePlayer.getState().isPlaying).toBe(true);
    Reflect.deleteProperty(el, "ended");
  });

  it("does not let a late play event undo our own pause", async () => {
    await usePlayer.getState().playQueue([track("a")], 0);
    const el = lastPlayed();
    usePlayer.getState().toggle(); // we pause
    expect(usePlayer.getState().isPlaying).toBe(false);
    withPaused(el, true);
    el.dispatchEvent(new Event("play"));
    expect(usePlayer.getState().isPlaying).toBe(false);
    Reflect.deleteProperty(el, "paused");
  });

  it("ignores events from an element that was released", async () => {
    await usePlayer.getState().playQueue([track("a")], 0);
    const el = lastPlayed();
    // Nothing can play this track, so the element is released and no backend is active.
    await usePlayer.getState().playQueue([track("sdk:nothing")], 0);
    expect(usePlayer.getState().isPlaying).toBe(false);
    el.dispatchEvent(new Event("play"));
    expect(usePlayer.getState().isPlaying).toBe(false);
  });
});

describe("audio effects routing", () => {
  beforeEach(() => {
    FakeAudioContext.instances = [];
    vi.stubGlobal("AudioContext", FakeAudioContext);
  });

  async function enableEffects() {
    usePluginHost.getState().register(effectPlugin);
    await usePluginHost.getState().setEnabled("test.fx", true);
  }

  it("routes same-origin media through the effects with anonymous CORS", async () => {
    await enableEffects();
    expect(audioGraph.wanted).toBe(true);
    await usePlayer.getState().playQueue([track("same:1")], 0);
    const el = lastPlayed();
    expect(el.crossOrigin).toBe("anonymous");
    expect(audioGraph.isCaptured(el)).toBe(true);
    expect(FakeAudioContext.instances).toHaveLength(1);
    await usePluginHost.getState().setEnabled("test.fx", false);
    expect(audioGraph.wanted).toBe(false);
  });

  it("plays cross-origin media without CORS plainly instead of going silent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("blocked by CORS");
      }),
    );
    await enableEffects();
    await usePlayer.getState().playQueue([track("radio")], 0);
    const el = lastPlayed();
    expect(srcOf(el)).toBe(`${origin}/radio.mp3`);
    expect(el.crossOrigin).toBeNull();
    expect(audioGraph.isCaptured(el)).toBe(false);
    expect(usePlayer.getState().isPlaying).toBe(true);
  });

  it("routes cross-origin media that sends CORS headers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 206 })));
    await enableEffects();
    await usePlayer.getState().playQueue([track("cors")], 0);
    const el = lastPlayed();
    expect(el.crossOrigin).toBe("anonymous");
    expect(audioGraph.isCaptured(el)).toBe(true);
  });

  it("never reuses a captured element for media that cannot be routed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("blocked");
      }),
    );
    await enableEffects();
    await usePlayer.getState().playQueue([track("same:1")], 0);
    const routed = lastPlayed();
    expect(audioGraph.isCaptured(routed)).toBe(true);
    await usePlayer.getState().playQueue([track("radio")], 0);
    const plain = lastPlayed();
    expect(plain).not.toBe(routed);
    expect(audioGraph.isCaptured(plain)).toBe(false);
  });

  it("plays plain when Web Audio does not exist", async () => {
    vi.stubGlobal("AudioContext", undefined);
    // Fresh graph state is not possible for the singleton, so use a track the graph never sees.
    await usePlayer.getState().playQueue([track("a")], 0);
    expect(usePlayer.getState().isPlaying).toBe(true);
  });
});

describe("gapless and crossfade", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance"] });
  });

  const queue = () => [track("a"), track("b"), track("c")];

  it("buffers the next track ahead and hands over to it without loading again", async () => {
    await usePlayer.getState().playQueue(queue(), 0);
    useTuning.getState().set({ gapless: true });
    const first = lastPlayed();
    playSpy.mockClear();

    clock.time = 185;
    await vi.advanceTimersByTimeAsync(300);
    // b is loaded into a second element but not playing yet.
    expect(playSpy).not.toHaveBeenCalled();
    expect(usePlayer.getState().current?.id).toBe("a");

    clock.time = 199.95;
    await vi.advanceTimersByTimeAsync(300);
    expect(usePlayer.getState().current?.id).toBe("b");
    const second = lastPlayed();
    expect(second).not.toBe(first);
    expect(srcOf(second)).toBe(`${origin}/b.mp3`);
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(usePlayer.getState().isPlaying).toBe(true);
  });

  it("does nothing special when neither option is on", async () => {
    await usePlayer.getState().playQueue(queue(), 0);
    clock.time = 199.95;
    await vi.advanceTimersByTimeAsync(500);
    expect(usePlayer.getState().current?.id).toBe("a");
  });

  it("does not buffer tracks that play in a vendor SDK", async () => {
    const q = [track("a"), { ...track("sdk:x"), source: "spotify" }];
    await usePlayer.getState().playQueue(q, 0);
    useTuning.getState().set({ gapless: true, crossfadeSec: 4 });
    playSpy.mockClear();
    clock.time = 199;
    await vi.advanceTimersByTimeAsync(500);
    expect(playSpy).not.toHaveBeenCalled();
    expect(usePlayer.getState().current?.id).toBe("a");
  });

  it("crossfades into the next track and makes it current when the blend ends", async () => {
    await usePlayer.getState().playQueue(queue(), 0);
    useTuning.getState().set({ crossfadeSec: 4 });
    const outgoing = lastPlayed();
    playSpy.mockClear();

    clock.time = 196.2;
    await vi.advanceTimersByTimeAsync(300);
    const incoming = lastPlayed();
    expect(incoming).not.toBe(outgoing);
    expect(srcOf(incoming)).toBe(`${origin}/b.mp3`);
    // Mid-blend: both audible, the current track has not changed yet.
    await vi.advanceTimersByTimeAsync(1500);
    expect(outgoing.volume).toBeGreaterThan(0);
    expect(outgoing.volume).toBeLessThan(0.8);
    expect(incoming.volume).toBeGreaterThan(0);
    expect(usePlayer.getState().current?.id).toBe("a");

    await vi.advanceTimersByTimeAsync(4000);
    expect(usePlayer.getState().current?.id).toBe("b");
    expect(usePlayer.getState().index).toBe(1);
    expect(incoming.volume).toBeCloseTo(0.8);
    expect(outgoing.getAttribute("src")).toBeNull();
    expect(usePlayer.getState().isPlaying).toBe(true);
  });

  it("cuts the blend short when the user skips", async () => {
    await usePlayer.getState().playQueue(queue(), 0);
    useTuning.getState().set({ crossfadeSec: 6 });
    clock.time = 194.5;
    await vi.advanceTimersByTimeAsync(300);
    expect(usePlayer.getState().current?.id).toBe("a");
    await usePlayer.getState().next();
    expect(usePlayer.getState().current?.id).toBe("b");
    expect(usePlayer.getState().index).toBe(1);
    // No second hand-over happens afterwards.
    clock.time = 0;
    await vi.advanceTimersByTimeAsync(2000);
    expect(usePlayer.getState().current?.id).toBe("b");
  });

  it("a seek during the blend stays on the outgoing song at full volume", async () => {
    await usePlayer.getState().playQueue(queue(), 0);
    useTuning.getState().set({ crossfadeSec: 6 });
    const outgoing = lastPlayed();
    clock.time = 194.5;
    await vi.advanceTimersByTimeAsync(300);
    const incoming = lastPlayed();
    expect(incoming).not.toBe(outgoing);
    await vi.advanceTimersByTimeAsync(1500);
    clock.time = 60;
    usePlayer.getState().seek(60);
    expect(usePlayer.getState().current?.id).toBe("a");
    expect(outgoing.volume).toBeCloseTo(0.8);
    expect(incoming.getAttribute("src")).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect(usePlayer.getState().current?.id).toBe("a");
  });

  it("does not crossfade past a stop-after-track request", async () => {
    await usePlayer.getState().playQueue(queue(), 0);
    useTuning.getState().set({ crossfadeSec: 4, stopAfterTrack: true });
    playSpy.mockClear();
    clock.time = 197;
    await vi.advanceTimersByTimeAsync(500);
    expect(playSpy).not.toHaveBeenCalled();
    expect(usePlayer.getState().current?.id).toBe("a");
  });

  it("uses the same shuffled pick for buffering and for playing", async () => {
    await usePlayer.getState().playQueue(queue(), 0);
    usePlayer.getState().toggleShuffle();
    useTuning.getState().set({ gapless: true });
    vi.spyOn(Math, "random").mockReturnValueOnce(0.99).mockReturnValue(0);
    clock.time = 185;
    await vi.advanceTimersByTimeAsync(300);
    clock.time = 199.95;
    await vi.advanceTimersByTimeAsync(300);
    expect(usePlayer.getState().current?.id).toBe("c");
  });
});

describe("holding the track for a loop", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance"] });
  });

  const queue = () => [track("a"), track("b")];

  it("plans no crossfade, gapless hand-over or buffering while a plugin holds the track", async () => {
    await usePlayer.getState().playQueue(queue(), 0);
    useTuning.getState().set({ crossfadeSec: 4, gapless: true, holdTrack: true });
    playSpy.mockClear();
    clock.time = 197;
    await vi.advanceTimersByTimeAsync(500);
    expect(playSpy).not.toHaveBeenCalled();
    expect(usePlayer.getState().current?.id).toBe("a");
    // Letting go brings the normal behaviour back at once.
    useTuning.getState().set({ holdTrack: false });
    await vi.advanceTimersByTimeAsync(500);
    expect(usePlayer.getState().current?.id).toBe("a");
    expect(playSpy).toHaveBeenCalled();
  });

  it("keeps the position fresh between media events while held", async () => {
    await usePlayer.getState().playQueue(queue(), 0);
    useTuning.getState().set({ holdTrack: true });
    clock.time = 42.5;
    await vi.advanceTimersByTimeAsync(150);
    expect(usePlayer.getState().position).toBeCloseTo(42.5);
  });

  it("reports which engine plays the track", async () => {
    expect(usePlayer.getState().engine).toBeDefined();
    await usePlayer.getState().playQueue([track("a")], 0);
    expect(usePlayer.getState().engine).toBe("html");
  });
});
