import { describe, expect, it } from "vitest";
import { crossfadeGains, GAPLESS_LEAD_SEC, planTransition, PRELOAD_LEAD_SEC, type TransitionInput } from "./transition";

const base: TransitionInput = {
  position: 0,
  duration: 200,
  rate: 1,
  crossfadeSec: 0,
  gapless: false,
  hasNext: true,
  next: "none",
  crossfading: false,
  stopAfterTrack: false,
};
const plan = (over: Partial<TransitionInput>) => planTransition({ ...base, ...over });

describe("planTransition", () => {
  it("does nothing when neither crossfade nor gapless is on", () => {
    expect(plan({ position: 199.95 }).kind).toBe("none");
  });

  it("does nothing without a next track, unknown duration, a running fade or a stop request", () => {
    const near = { gapless: true, position: 199.95 };
    expect(plan({ ...near, hasNext: false }).kind).toBe("none");
    expect(plan({ ...near, duration: 0 }).kind).toBe("none");
    expect(plan({ ...near, duration: NaN }).kind).toBe("none");
    expect(plan({ ...near, crossfading: true }).kind).toBe("none");
    expect(plan({ ...near, stopAfterTrack: true }).kind).toBe("none");
  });

  it("pre-buffers the next track a little before the end", () => {
    const g = { gapless: true };
    expect(plan({ ...g, position: 100 }).kind).toBe("none");
    expect(plan({ ...g, position: 200 - PRELOAD_LEAD_SEC + 1 }).kind).toBe("preload");
    expect(plan({ ...g, position: 200 - PRELOAD_LEAD_SEC + 1, next: "loading" }).kind).toBe("none");
    expect(plan({ ...g, position: 200 - PRELOAD_LEAD_SEC + 1, next: "ready" }).kind).toBe("none");
  });

  it("switches at the very end for gapless", () => {
    expect(plan({ gapless: true, position: 200 - GAPLESS_LEAD_SEC / 2, next: "ready" })).toEqual({ kind: "switch" });
  });

  it("starts a crossfade when the remaining time reaches the fade length", () => {
    const c = { crossfadeSec: 6 };
    expect(plan({ ...c, position: 190 }).kind).toBe("preload");
    const p = plan({ ...c, position: 194.5 });
    expect(p.kind).toBe("crossfade");
    expect(p.kind === "crossfade" && p.seconds).toBeCloseTo(5.5);
  });

  it("preloads early enough for a crossfade", () => {
    expect(plan({ crossfadeSec: 10, position: 200 - 10 - PRELOAD_LEAD_SEC + 1 }).kind).toBe("preload");
  });

  it("shortens the fade on short tracks (at most half the track)", () => {
    const p = plan({ crossfadeSec: 12, duration: 10, position: 5 });
    expect(p.kind).toBe("crossfade");
  });

  it("measures time left in real time at other speeds", () => {
    // 20s of media left at 2x is 10 real seconds: inside a 12s fade.
    expect(plan({ crossfadeSec: 12, rate: 2, position: 180 }).kind).toBe("crossfade");
    // At 1x it is still 20s away.
    expect(plan({ crossfadeSec: 12, rate: 1, position: 180 }).kind).toBe("preload");
  });
});

describe("crossfadeGains", () => {
  it("starts on the old track and ends on the new one", () => {
    expect(crossfadeGains(0)).toEqual({ out: 1, in: 0 });
    const end = crossfadeGains(1);
    expect(end.out).toBeCloseTo(0);
    expect(end.in).toBeCloseTo(1);
  });

  it("keeps constant power in the middle (no volume dip)", () => {
    for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const g = crossfadeGains(p);
      expect(g.out ** 2 + g.in ** 2).toBeCloseTo(1);
    }
  });

  it("clamps bad input", () => {
    expect(crossfadeGains(-3)).toEqual({ out: 1, in: 0 });
    expect(crossfadeGains(NaN).out).toBe(1);
    expect(crossfadeGains(7).in).toBeCloseTo(1);
  });
});
