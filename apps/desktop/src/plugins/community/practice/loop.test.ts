import { describe, expect, it } from "vitest";
import {
  clampBpm,
  clampRate,
  countInPlan,
  formatTime,
  isActive,
  loopJump,
  MIN_LOOP,
  noLoop,
  nudge,
  setA,
  setB,
  tapTempo,
} from "./loop";

describe("setting the loop", () => {
  it("sets A and B at the playhead and turns the loop on", () => {
    const a = setA(noLoop, 12.34, 200);
    expect(a).toEqual({ a: 12.3, b: null, enabled: false });
    const ab = setB(a, 20.04, 200);
    expect(ab).toEqual({ a: 12.3, b: 20, enabled: true });
    expect(isActive(ab)).toBe(true);
  });
  it("starts A at the beginning of the song when only B is set", () => {
    expect(setB(noLoop, 3, 200)).toEqual({ a: 0, b: 3, enabled: true });
  });
  it("moves A back when B is set too close to it", () => {
    const loop = setB({ a: 30, b: null, enabled: false }, 30.2, 200);
    expect(loop.a).toBeLessThan(30);
    expect(loop.b! - loop.a!).toBeGreaterThanOrEqual(MIN_LOOP);
  });
  it("drops B when A is moved past it", () => {
    const loop = setA({ a: 10, b: 20, enabled: true }, 25, 200);
    expect(loop).toMatchObject({ a: 25, b: null, enabled: false });
  });
  it("keeps the points inside the song", () => {
    expect(setB(noLoop, 999, 200).b).toBe(200);
    expect(setA(noLoop, -5, 200).a).toBe(0);
  });
});

describe("nudging the points", () => {
  const loop = { a: 10, b: 20, enabled: true };
  it("moves a point by a small step", () => {
    expect(nudge(loop, "a", -0.1, 200).a).toBe(9.9);
    expect(nudge(loop, "b", 0.1, 200).b).toBe(20.1);
  });
  it("never lets the loop collapse or leave the song", () => {
    expect(nudge(loop, "a", 50, 200).a).toBe(20 - MIN_LOOP);
    expect(nudge(loop, "b", -50, 200).b).toBe(10 + MIN_LOOP);
    expect(nudge(loop, "a", -50, 200).a).toBe(0);
    expect(nudge(loop, "b", 500, 200).b).toBe(200);
  });
  it("does nothing without a complete loop", () => {
    expect(nudge(noLoop, "a", 1, 100)).toBe(noLoop);
  });
});

describe("loopJump", () => {
  const loop = { a: 10, b: 20, enabled: true };
  it("jumps back to A at the end of the loop", () => {
    expect(loopJump(20, loop)).toBe(10);
    expect(loopJump(19.98, loop)).toBe(10);
    expect(loopJump(20.4, loop)).toBe(10);
  });
  it("leaves playback alone inside the loop and before it", () => {
    expect(loopJump(15, loop)).toBeNull();
    expect(loopJump(3, loop)).toBeNull();
  });
  it("lets go when the person has moved well past the loop", () => {
    expect(loopJump(60, loop)).toBeNull();
  });
  it("does nothing when the loop is off or incomplete", () => {
    expect(loopJump(20, { ...loop, enabled: false })).toBeNull();
    expect(loopJump(20, { a: 10, b: null, enabled: true })).toBeNull();
  });
  it("jumps early when asked to, for coarse position clocks", () => {
    expect(loopJump(19.4, loop, 0.8)).toBe(10);
    expect(loopJump(19.4, loop)).toBeNull();
  });
});

describe("speed", () => {
  it("keeps the speed in a usable range", () => {
    expect(clampRate(0.1)).toBe(0.5);
    expect(clampRate(3)).toBe(1.25);
    expect(clampRate(0.756)).toBe(0.76);
  });

});

describe("count-in", () => {
  it("places clicks one beat apart", () => {
    expect(countInPlan(120, 4)).toEqual({ clicks: [0, 0.5, 1, 1.5], total: 2 });
    expect(countInPlan(60, 2)).toEqual({ clicks: [0, 1], total: 2 });
  });
  it("copes with silly input", () => {
    expect(countInPlan(0, 0).clicks).toHaveLength(1);
    expect(countInPlan(1000, 100).clicks).toHaveLength(8);
    expect(clampBpm(NaN)).toBe(100);
    expect(clampBpm(10)).toBe(40);
  });
  it("works out tempo from taps", () => {
    expect(tapTempo([0])).toBeNull();
    expect(tapTempo([0, 500, 1000, 1500])).toBe(120);
    expect(tapTempo([0, 1000])).toBe(60);
  });
  it("starts a fresh count after a long pause", () => {
    expect(tapTempo([0, 400, 800, 20000, 20500, 21000])).toBe(120);
  });
});

describe("formatTime", () => {
  it("shows minutes, seconds and tenths", () => {
    expect(formatTime(0)).toBe("0:00.0");
    expect(formatTime(75.34)).toBe("1:15.3");
    expect(formatTime(null)).toBe("--:--.-");
  });
});