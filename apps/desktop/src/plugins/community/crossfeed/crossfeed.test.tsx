import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderLive } from "../_audio-kit/testing";
import {
  DEFAULT_STEREO,
  applyMatrix,
  crossfeedGains,
  gainsFor,
  sanitizeStereo,
  widenerGains,
} from "./crossfeed";
import plugin, { StereoPanel, stereoEffect, stereoPrefs } from "./index";

describe("crossfeed maths", () => {
  it("does nothing at zero strength", () => {
    const g = crossfeedGains(0);
    expect(g.cross).toBe(0);
    expect(g.direct).toBe(1);
  });

  it("keeps a centred sound at the same level at any strength", () => {
    for (const s of [0.2, 0.5, 1]) {
      const g = crossfeedGains(s);
      const [l, r] = applyMatrix(g, 0.5, 0.5);
      expect(l).toBeCloseTo(0.5);
      expect(r).toBeCloseTo(0.5);
    }
  });

  it("moves part of a hard-left sound to the right ear, more with more strength", () => {
    const low = applyMatrix(crossfeedGains(0.2), 1, 0);
    const high = applyMatrix(crossfeedGains(1), 1, 0);
    expect(low[1]).toBeGreaterThan(0);
    expect(high[1]).toBeGreaterThan(low[1]);
    expect(high[0]).toBeLessThan(1);
    // The cross path is filtered and delayed like a head shadow.
    expect(crossfeedGains(1).cutoff).toBe(700);
    expect(crossfeedGains(1).delay).toBeGreaterThan(0);
  });
});

describe("widener maths", () => {
  it("is neutral at width 1 and mono at 0", () => {
    expect(applyMatrix(widenerGains(1), 0.8, -0.2)).toEqual([0.8, -0.2]);
    const [l, r] = applyMatrix(widenerGains(0), 0.8, -0.2);
    expect(l).toBeCloseTo(0.3);
    expect(r).toBeCloseTo(0.3);
  });

  it("never changes a centred sound, and widens a side sound", () => {
    const [l, r] = applyMatrix(widenerGains(1.8), 0.5, 0.5);
    expect(l).toBeCloseTo(0.5);
    expect(r).toBeCloseTo(0.5);
    const [wl, wr] = applyMatrix(widenerGains(2), 0.6, 0.2);
    expect(wl - wr).toBeCloseTo(2 * (0.6 - 0.2));
  });

  it("has no filter or delay on the cross path", () => {
    expect(widenerGains(1.5)).toMatchObject({ cutoff: 20000, delay: 0 });
  });
});

describe("settings", () => {
  it("sanitizes and picks gains by mode", () => {
    expect(sanitizeStereo({ mode: "nope" as never, feed: 5, width: -1 })).toEqual({ mode: "crossfeed", feed: 1, width: 0 });
    expect(gainsFor({ ...DEFAULT_STEREO, mode: "off" })).toMatchObject({ direct: 1, cross: 0 });
    expect(gainsFor({ ...DEFAULT_STEREO, mode: "widen", width: 1 }).cross).toBe(0);
  });
});

function fakeCtx() {
  const param = () => ({ value: 0, setTargetAtTime: vi.fn() });
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  type FakeGain = { gain: ReturnType<typeof param>; channelCount: number } & ReturnType<typeof node>;
  const made = { gains: [] as FakeGain[], lps: [] as Array<{ frequency: ReturnType<typeof param> } & ReturnType<typeof node>>, delays: [] as Array<{ delayTime: ReturnType<typeof param> } & ReturnType<typeof node>> };
  const ctx = {
    currentTime: 3,
    createGain: () => {
      const g: FakeGain = { ...node(), gain: param(), channelCount: 0 };
      made.gains.push(g);
      return g;
    },
    createChannelSplitter: () => node(),
    createChannelMerger: () => node(),
    createBiquadFilter: () => {
      const f = { ...node(), type: "", frequency: param() };
      made.lps.push(f);
      return f;
    },
    createDelay: () => {
      const d = { ...node(), delayTime: param() };
      made.delays.push(d);
      return d;
    },
  };
  return { ctx: ctx as unknown as AudioContext, made };
}

describe("stereo effect", () => {
  it("builds a two-ear matrix and updates it live", () => {
    stereoPrefs.set({ mode: "crossfeed", feed: 1 });
    const { ctx, made } = fakeCtx();
    const nodes = stereoEffect.create(ctx);
    // input + 2 direct + 2 cross gains, 2 low-pass filters, 2 delays.
    expect(made.gains).toHaveLength(5);
    expect(made.lps).toHaveLength(2);
    expect(made.delays).toHaveLength(2);
    expect(made.lps[0].frequency.value).toBe(700);
    expect(nodes.input).toBe(made.gains[0]);
    expect(made.gains[0].channelCount).toBe(2);

    stereoPrefs.set({ mode: "off" });
    expect(made.gains[1].gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 3, 0.03);
    expect(made.gains[2].gain.setTargetAtTime).toHaveBeenCalled();
    nodes.dispose?.();
  });
});

describe("plugin", () => {
  it("registers an effect and a panel with only the needed capabilities", () => {
    expect(plugin.manifest.capabilities.sort()).toEqual(["audio.dsp", "storage", "ui.settings"]);
    const seen: string[] = [];
    plugin.activate({
      storage: { get: () => null, set: () => undefined, remove: () => undefined },
      registerAudioEffect: (e: { id: string }) => seen.push(e.id),
      registerSettingsPanel: (p: { id: string }) => seen.push(p.id),
    } as never);
    expect(seen).toEqual(["cadence.crossfeed", "crossfeed"]);
  });

  it("renders the panel for the active mode", () => {
    stereoPrefs.set({ mode: "crossfeed" });
    const view = renderLive(<StereoPanel />);
    expect(view.html()).toContain("Strength");
    act(() => stereoPrefs.set({ mode: "widen" }));
    expect(view.html()).toContain("Stereo width");
    view.unmount();
  });
});
