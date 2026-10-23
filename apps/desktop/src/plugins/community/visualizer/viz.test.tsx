import { describe, expect, it, vi } from "vitest";
import { renderLive } from "../_audio-kit/testing";
import { FRAME_MS, SMOOTHING, bandEdges, bandLevels, peakOf, smoothLevels, waveformPoints } from "./viz";
import plugin, { VisualizerPage, vizEffect, vizPrefs } from "./index";

describe("bandEdges", () => {
  it("are log-spaced between the limits", () => {
    const e = bandEdges(4, 100, 1600);
    expect(e).toHaveLength(5);
    expect(e[0]).toBeCloseTo(100);
    expect(e[4]).toBeCloseTo(1600);
    expect(e[2] / e[1]).toBeCloseTo(e[1] / e[0]);
  });
});

describe("bandLevels", () => {
  const sampleRate = 48000;
  const bins = 1024; // 23.4 Hz per bin

  it("is silent for silence and full for full scale", () => {
    expect(peakOf(bandLevels(new Uint8Array(bins), sampleRate, 16))).toBe(0);
    const loud = bandLevels(new Uint8Array(bins).fill(255), sampleRate, 16);
    expect(loud.every((v) => v === 1)).toBe(true);
  });

  it("puts a low tone in the low bands and a high tone in the high bands", () => {
    const low = new Uint8Array(bins);
    low[Math.round(100 / 23.4375)] = 255; // ~100 Hz
    const lowLevels = bandLevels(low, sampleRate, 16);
    expect(lowLevels.indexOf(peakOf(lowLevels))).toBeLessThan(4);

    const high = new Uint8Array(bins);
    high.fill(255, Math.round(8000 / 23.4375), Math.round(9000 / 23.4375));
    const highLevels = bandLevels(high, sampleRate, 16);
    expect(highLevels.indexOf(peakOf(highLevels))).toBeGreaterThan(10);
  });

  it("stays between 0 and 1 and returns one value per band", () => {
    const levels = bandLevels(Uint8Array.from({ length: bins }, (_, i) => i % 256), sampleRate, 24);
    expect(levels).toHaveLength(24);
    expect(levels.every((v) => v >= 0 && v <= 1)).toBe(true);
  });
});

describe("smoothLevels", () => {
  it("rises faster than it falls and never overshoots", () => {
    const up = smoothLevels([0], [1], 0.3, 0.07)[0];
    const down = smoothLevels([1], [0], 0.3, 0.07)[0];
    expect(up).toBeCloseTo(0.3);
    expect(1 - down).toBeCloseTo(0.07);
    expect(smoothLevels([0.5], [0.5])[0]).toBe(0.5);
  });

  it("limits how much a single frame can change (no flashing)", () => {
    let level = [0];
    const steps: number[] = [];
    for (let i = 0; i < 5; i++) {
      const next = smoothLevels(level, [1], SMOOTHING.calm.attack, SMOOTHING.calm.release);
      steps.push(next[0] - level[0]);
      level = next;
    }
    expect(Math.max(...steps)).toBeLessThanOrEqual(SMOOTHING.calm.attack);
    expect(steps[0]).toBeGreaterThanOrEqual(steps[4]);
  });

  it("still motion changes slowly and redraws once a second", () => {
    expect(FRAME_MS.still).toBe(1000);
    expect(FRAME_MS.calm).toBeLessThan(FRAME_MS.still);
    expect(SMOOTHING.still.attack).toBeLessThan(SMOOTHING.calm.attack);
  });
});

describe("waveformPoints", () => {
  it("centres on silence and reaches the extremes", () => {
    expect(waveformPoints(new Uint8Array(256).fill(128), 8).every((v) => v === 0)).toBe(true);
    const pts = waveformPoints(Uint8Array.from({ length: 256 }, (_, i) => (i < 128 ? 255 : 0)), 2);
    expect(pts[0]).toBeCloseTo(0.99, 1);
    expect(pts[1]).toBe(-1);
    expect(waveformPoints(new Uint8Array(0), 4)).toEqual([]);
  });
});

describe("visualizer effect", () => {
  it("is a pass-through analyser, and cleans up", () => {
    const node = { fftSize: 0, smoothingTimeConstant: 0, connect: vi.fn() };
    const nodes = vizEffect.create({ createAnalyser: () => node } as unknown as AudioContext);
    expect(nodes.input).toBe(node);
    expect(nodes.output).toBe(node);
    expect(node.fftSize).toBe(2048);
    expect(node.smoothingTimeConstant).toBe(0.8);
    expect(vizEffect.order).toBeGreaterThan(100);
    nodes.dispose?.();
  });
});

describe("visualizer plugin", () => {
  it("registers an effect and a sidebar page and keeps its choices", () => {
    expect(plugin.manifest.capabilities.sort()).toEqual(["audio.dsp", "player.read", "storage", "ui.sidebar"]);
    const seen: string[] = [];
    const map = new Map<string, unknown>();
    plugin.activate({
      storage: { get: (k: string) => (map.get(k) as never) ?? null, set: (k: string, v: unknown) => void map.set(k, v), remove: () => undefined },
      player: { getState: () => ({ isPlaying: false }) },
      registerAudioEffect: (e: { id: string }) => seen.push(e.id),
      registerSidebarItem: (s: { id: string }) => seen.push(s.id),
    } as never);
    expect(seen).toEqual(["cadence.visualizer", "visualizer"]);
    vizPrefs.set({ mode: "wave" });
    expect((map.get("settings") as { mode: string }).mode).toBe("wave");
  });

  it("renders the page with its controls and a labelled canvas", () => {
    // jsdom has no canvas; the page must cope with a missing 2D context.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const view = renderLive(<VisualizerPage />);
    expect(view.html()).toContain("Visualizer");
    expect(view.html()).toContain("Spectrum");
    expect(view.html()).toContain("Almost still");
    expect(view.container.querySelector("canvas")?.getAttribute("aria-label")).toBe("Live audio visualization");
    view.unmount();
  });
});
