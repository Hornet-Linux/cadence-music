import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import {
  BAND_COUNT,
  BAND_FREQS,
  BAND_Q,
  BUILT_IN_PRESETS,
  DEFAULT_EQ,
  bandResponseDb,
  dbToGain,
  formatDb,
  formatHz,
  headroomFor,
  matchPreset,
  responseCurve,
  sanitizeGains,
  sanitizeSettings,
  savePreset,
  totalResponseDb,
} from "./eq";
import { applyLive, eqEffect, eqPrefs } from "./engine";
import { EqPanel } from "./EqPanel";
import equalizerPlugin from "./index";

describe("presets", () => {
  it("has the eight named presets, each with 10 bands in range", () => {
    expect(BUILT_IN_PRESETS.map((p) => p.name)).toEqual([
      "Flat",
      "Bass boost",
      "Treble boost",
      "Vocal",
      "Acoustic",
      "Electronic",
      "Loudness",
      "Late night",
    ]);
    for (const p of BUILT_IN_PRESETS) {
      expect(p.gains).toHaveLength(BAND_COUNT);
      expect(Math.max(...p.gains)).toBeLessThanOrEqual(12);
      expect(Math.min(...p.gains)).toBeGreaterThanOrEqual(-12);
    }
  });

  it("Flat is flat; boosts get negative headroom so they cannot clip", () => {
    const [flat, bass] = BUILT_IN_PRESETS;
    expect(flat.preamp).toBeCloseTo(0);
    expect(bass.preamp).toBe(-3);
    expect(headroomFor([0, 0, 0])).toBeCloseTo(0);
    expect(headroomFor([-5, -2])).toBeCloseTo(0);
    expect(headroomFor([12, 12])).toBe(-6);
  });

  it("recognises a preset and notices hand edits", () => {
    const vocal = BUILT_IN_PRESETS[3];
    expect(matchPreset(vocal.preamp, vocal.gains)).toBe("Vocal");
    expect(matchPreset(vocal.preamp, vocal.gains.map((g, i) => (i === 0 ? g + 1 : g)))).toBe("");
  });
});

describe("custom presets", () => {
  it("saves, overwrites by name and refuses built-in names", () => {
    let custom = savePreset([], "  My mix ", -1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(custom).toHaveLength(1);
    expect(custom[0].name).toBe("My mix");
    custom = savePreset(custom, "my mix", 0, Array(10).fill(2));
    expect(custom).toHaveLength(1);
    expect(custom[0].gains[0]).toBe(2);
    expect(savePreset(custom, "flat", 0, Array(10).fill(0))).toBe(custom);
    expect(savePreset(custom, "   ", 0, Array(10).fill(0))).toBe(custom);
  });

  it("keeps at most 20 and finds a saved one again", () => {
    let custom: ReturnType<typeof savePreset> = [];
    for (let i = 0; i < 25; i++) custom = savePreset(custom, `p${i}`, 0, Array(10).fill(i % 5));
    expect(custom).toHaveLength(20);
    expect(custom.at(-1)?.name).toBe("p24");
    expect(matchPreset(0, Array(10).fill(4), custom)).toBe("p9");
  });
});

describe("sanitizing stored data", () => {
  it("clamps and pads gains", () => {
    expect(sanitizeGains([99, -99, "x", null])).toEqual([12, -12, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(sanitizeGains(undefined)).toEqual(Array(10).fill(0));
  });

  it("repairs corrupt settings", () => {
    const s = sanitizeSettings({ on: undefined, preamp: 400, gains: "nope" as unknown as number[], custom: [{ name: "", preamp: 0, gains: [] }, null as never] });
    expect(s.on).toBe(true);
    expect(s.preamp).toBe(12);
    expect(s.gains).toEqual(DEFAULT_EQ.gains);
    expect(s.custom).toEqual([]);
    expect(sanitizeSettings(null)).toEqual({ ...DEFAULT_EQ, preset: "" });
  });
});

describe("filter maths", () => {
  it("converts dB to gain", () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(6)).toBeCloseTo(1.995, 2);
    expect(dbToGain(-20)).toBeCloseTo(0.1);
  });

  it("a peaking band hits its gain at its centre and fades far away", () => {
    expect(bandResponseDb("peaking", 1000, 6, BAND_Q, 1000)).toBeCloseTo(6, 1);
    expect(Math.abs(bandResponseDb("peaking", 1000, 6, BAND_Q, 40))).toBeLessThan(0.3);
    expect(Math.abs(bandResponseDb("peaking", 1000, 6, BAND_Q, 16000))).toBeLessThan(0.6);
    expect(bandResponseDb("peaking", 1000, -6, BAND_Q, 1000)).toBeCloseTo(-6, 1);
  });

  it("shelves apply their gain on their own side only", () => {
    expect(bandResponseDb("lowshelf", 31, 6, BAND_Q, 20)).toBeGreaterThan(4.5);
    expect(Math.abs(bandResponseDb("lowshelf", 31, 6, BAND_Q, 5000))).toBeLessThan(0.1);
    expect(bandResponseDb("highshelf", 16000, 6, BAND_Q, 20000)).toBeGreaterThan(4);
    expect(Math.abs(bandResponseDb("highshelf", 16000, 6, BAND_Q, 200))).toBeLessThan(0.1);
  });

  it("zero gain is exactly flat", () => {
    expect(bandResponseDb("peaking", 500, 0, BAND_Q, 500)).toBe(0);
    expect(totalResponseDb(Array(10).fill(0), 1234)).toBe(0);
  });

  it("bands add up and the curve covers 20 Hz to 20 kHz", () => {
    const bass = BUILT_IN_PRESETS[1];
    const curve = responseCurve(bass.gains, bass.preamp, 32);
    expect(curve).toHaveLength(32);
    expect(curve[0].f).toBeCloseTo(20);
    expect(curve.at(-1)!.f).toBeCloseTo(20000);
    expect(curve[0].db).toBeGreaterThan(curve.at(-1)!.db);
    expect(totalResponseDb(bass.gains, 62)).toBeGreaterThan(4);
  });

  it("formats labels", () => {
    expect(formatHz(31)).toBe("31 Hz");
    expect(formatHz(16000)).toBe("16 kHz");
    expect(formatHz(1000)).toBe("1 kHz");
    expect(formatDb(3)).toBe("+3.0 dB");
    expect(formatDb(-2.3)).toBe("-2.3 dB");
    expect(BAND_FREQS).toHaveLength(10);
  });
});

function fakeContext() {
  const param = () => ({ value: 0, setTargetAtTime: vi.fn() });
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const filters: Array<{ type: string; frequency: { value: number }; Q: { value: number }; gain: ReturnType<typeof param> } & ReturnType<typeof node>> = [];
  const preamp = { ...node(), gain: param() };
  const ctx = {
    currentTime: 1,
    createGain: () => preamp,
    createBiquadFilter: () => {
      const f = { ...node(), type: "", frequency: { value: 0 }, Q: { value: 0 }, gain: param() };
      filters.push(f);
      return f;
    },
  };
  return { ctx: ctx as unknown as AudioContext, filters, preamp };
}

describe("equalizer effect", () => {
  it("builds a preamp and ten filters of the right types and frequencies", () => {
    eqPrefs.set({ on: true, preamp: -3, gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] });
    const { ctx, filters, preamp } = fakeContext();
    const nodes = eqEffect.create(ctx);
    expect(nodes.input).toBe(preamp);
    expect(filters).toHaveLength(10);
    expect(filters.map((f) => f.type)).toEqual(["lowshelf", ...Array(8).fill("peaking"), "highshelf"]);
    expect(filters.map((f) => f.frequency.value)).toEqual([...BAND_FREQS]);
    expect(filters[0].gain.value).toBe(6);
    expect(preamp.gain.value).toBeCloseTo(dbToGain(-3));
    expect(nodes.output).toBe(filters[9]);
  });

  it("follows setting changes live and bypasses when off", () => {
    eqPrefs.set({ on: true, preamp: 0, gains: Array(10).fill(0) });
    const { ctx, filters, preamp } = fakeContext();
    const nodes = eqEffect.create(ctx);
    eqPrefs.set({ gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 9] });
    expect(filters[9].gain.setTargetAtTime).toHaveBeenLastCalledWith(9, 1, 0.02);
    eqPrefs.set({ on: false });
    expect(filters[9].gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 1, 0.02);
    expect(preamp.gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 1, 0.02);
    nodes.dispose?.();
    filters[9].gain.setTargetAtTime.mockClear();
    applyLive();
    expect(filters[9].gain.setTargetAtTime).not.toHaveBeenCalled();
  });
});

describe("equalizer plugin", () => {
  it("asks only for the capabilities it uses and registers an effect and a panel", () => {
    expect(equalizerPlugin.manifest.capabilities.sort()).toEqual(["audio.dsp", "storage", "ui.settings"]);
    expect(equalizerPlugin.manifest.builtin).toBeFalsy();
    const store = new Map<string, unknown>();
    const registered: string[] = [];
    equalizerPlugin.activate({
      storage: {
        get: (k: string) => (store.get(k) as never) ?? null,
        set: (k: string, v: unknown) => void store.set(k, v),
        remove: (k: string) => void store.delete(k),
      },
      registerAudioEffect: (e: { id: string }) => registered.push(e.id),
      registerSettingsPanel: (p: { id: string }) => registered.push(p.id),
    } as never);
    expect(registered).toEqual(["cadence.equalizer", "equalizer"]);
    eqPrefs.set({ preamp: -2 });
    expect((store.get("settings") as { preamp: number }).preamp).toBe(-2);
  });

  it("renders the panel with presets and ten sliders", () => {
    const html = renderToString(<EqPanel />);
    for (const name of ["Flat", "Bass boost", "Late night"]) expect(html).toContain(name);
    expect(html.match(/type="range"/g)).toHaveLength(11); // preamp + 10 bands
    expect(html).toContain("Spotify and Apple Music");
  });
});
