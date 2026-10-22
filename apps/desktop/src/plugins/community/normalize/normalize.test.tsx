import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import type { Track } from "@/shared/types";
import {
  DEFAULT_NORMALIZE,
  formatGain,
  levelingParams,
  limiterParams,
  parseGainDb,
  readReplayGain,
  replayGainToApply,
  sanitizeNormalize,
} from "./normalize";
import plugin, { NormalizePanel, applyLive, normalizeEffect, normalizePrefs, useNormalizeStatus } from "./index";

const track = (extra: Record<string, unknown> = {}): Track => ({ id: "t", title: "T", artists: [], ...extra }) as Track;

describe("parseGainDb", () => {
  it("reads numbers and tag strings", () => {
    expect(parseGainDb(-6.5)).toBe(-6.5);
    expect(parseGainDb("-6.50 dB")).toBe(-6.5);
    expect(parseGainDb("+3.2")).toBe(3.2);
    expect(parseGainDb("−4 dB")).toBe(-4);
    expect(parseGainDb("-2,5 dB")).toBe(-2.5);
  });
  it("rejects nonsense", () => {
    expect(parseGainDb("loud")).toBeNull();
    expect(parseGainDb(NaN)).toBeNull();
    expect(parseGainDb(undefined)).toBeNull();
    expect(parseGainDb("5 dB extra")).toBeNull();
  });
});

describe("readReplayGain", () => {
  it("reads the object form and picks track or album", () => {
    const t = track({ replayGain: { trackGain: -7, albumGain: -5, trackPeak: 0.9, albumPeak: "1.1" } });
    expect(readReplayGain(t, "track")).toEqual({ gainDb: -7, peak: 0.9 });
    expect(readReplayGain(t, "album")).toEqual({ gainDb: -5, peak: 1.1 });
  });
  it("reads file-tag style fields and falls back between modes", () => {
    const t = track({ replaygain_track_gain: "-3.1 dB" });
    expect(readReplayGain(t, "track")?.gainDb).toBe(-3.1);
    expect(readReplayGain(t, "album")?.gainDb).toBe(-3.1);
  });
  it("returns null when there is nothing", () => {
    expect(readReplayGain(track(), "track")).toBeNull();
    expect(readReplayGain(null, "track")).toBeNull();
  });
});

describe("replayGainToApply", () => {
  it("adds pre-gain and clamps to a sane range", () => {
    expect(replayGainToApply({ gainDb: -6, peak: null }, 2)).toBe(-4);
    expect(replayGainToApply({ gainDb: -60, peak: null }, 0)).toBe(-24);
    expect(replayGainToApply({ gainDb: 40, peak: null }, 0)).toBe(12);
    expect(replayGainToApply(null, 3)).toBe(0);
  });
  it("never boosts a tagged peak past full scale", () => {
    // Peak 0.5 leaves about 6.02 dB of headroom.
    expect(replayGainToApply({ gainDb: 9, peak: 0.5 }, 0)).toBeCloseTo(6.02, 1);
    expect(replayGainToApply({ gainDb: 3, peak: 0.5 }, 0)).toBe(3);
  });
});

describe("compressor settings", () => {
  it("is transparent at 0 and firmer as the amount grows", () => {
    expect(levelingParams(0)).toMatchObject({ ratio: 1, threshold: 0, makeupDb: 0 });
    const gentle = levelingParams(0.3);
    const firm = levelingParams(1);
    expect(gentle.ratio).toBeLessThan(firm.ratio);
    expect(firm.ratio).toBe(4);
    expect(firm.threshold).toBeLessThan(gentle.threshold);
    expect(firm.makeupDb).toBeGreaterThan(gentle.makeupDb);
    expect(levelingParams(5).ratio).toBe(4);
  });
  it("limiter is hard when on and neutral when off", () => {
    expect(limiterParams(true).ratio).toBe(20);
    expect(limiterParams(false).ratio).toBe(1);
  });
});

describe("settings", () => {
  it("sanitizes values", () => {
    const s = sanitizeNormalize({ replayGain: true, mode: "weird" as never, preGainDb: 99, leveling: -1, limiter: false });
    expect(s).toEqual({ replayGain: true, mode: "track", preGainDb: 12, leveling: 0, limiter: false });
    expect(formatGain(-6.04)).toBe("-6.0 dB");
    expect(formatGain(2)).toBe("+2.0 dB");
  });
});

function fakeCtx() {
  const param = () => ({ value: 0, setTargetAtTime: vi.fn() });
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const comp = () => ({ ...node(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() });
  const gains: Array<ReturnType<typeof node> & { gain: ReturnType<typeof param> }> = [];
  const comps: Array<ReturnType<typeof comp>> = [];
  const ctx = {
    currentTime: 2,
    createGain: () => {
      const g = { ...node(), gain: param() };
      gains.push(g);
      return g;
    },
    createDynamicsCompressor: () => {
      const c = comp();
      comps.push(c);
      return c;
    },
  };
  return { ctx: ctx as unknown as AudioContext, gains, comps };
}

describe("normalize effect and plugin", () => {
  it("builds trim -> compressor -> make-up -> limiter and applies the track gain live", () => {
    normalizePrefs.set({ ...DEFAULT_NORMALIZE, leveling: 1 });
    useNormalizeStatus.setState({ track: track({ replayGain: { trackGain: -6 } }), gainDb: null });
    const { ctx, gains, comps } = fakeCtx();
    const nodes = normalizeEffect.create(ctx);
    expect(nodes.input).toBe(gains[0]);
    expect(nodes.output).toBe(comps[1]);
    expect(gains[0].gain.setTargetAtTime.mock.calls.at(-1)?.[0]).toBeCloseTo(10 ** (-6 / 20));
    expect(comps[0].ratio.setTargetAtTime).toHaveBeenLastCalledWith(4, 2, 0.05);
    expect(comps[1].ratio.setTargetAtTime).toHaveBeenLastCalledWith(20, 2, 0.05);
    expect(useNormalizeStatus.getState().gainDb).toBe(-6);

    // A track without tags goes back to unity gain.
    useNormalizeStatus.setState({ track: track() });
    applyLive();
    expect(gains[0].gain.setTargetAtTime.mock.calls.at(-1)?.[0]).toBe(1);
    expect(useNormalizeStatus.getState().gainDb).toBeNull();
    nodes.dispose?.();
  });

  it("tracks the now-playing track after activation", () => {
    let listener: (t: Track | null) => void = () => undefined;
    const store = new Map<string, unknown>();
    plugin.activate({
      storage: { get: (k: string) => (store.get(k) as never) ?? null, set: (k: string, v: unknown) => void store.set(k, v), remove: () => undefined },
      registerAudioEffect: () => undefined,
      registerSettingsPanel: () => undefined,
      onNowPlaying: (cb: (t: Track | null) => void) => {
        listener = cb;
        return () => undefined;
      },
    } as never);
    listener(track({ replayGain: { trackGain: -4 } }));
    expect(useNormalizeStatus.getState().gainDb).toBe(-4);
  });

  it("renders its panel", () => {
    expect(plugin.manifest.capabilities.sort()).toEqual(["audio.dsp", "player.read", "storage", "ui.settings"]);
    useNormalizeStatus.setState({ track: track(), gainDb: null });
    const html = renderToString(<NormalizePanel />);
    expect(html).toContain("ReplayGain");
    expect(html).toContain("Play a song to see what is applied");
  });
});
