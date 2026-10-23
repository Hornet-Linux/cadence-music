import { describe, expect, it } from "vitest";
import { clockOffset, correctDrift, describeDrift, DRIFT, expectedPosition, reconcile, type HostSnapshot } from "./follow";

const host = (over: Partial<HostSnapshot> = {}): HostSnapshot => ({
  trackId: "t1",
  playing: true,
  position: 30,
  updatedAt: 1_000_000,
  seq: 1,
  durationSec: 200,
  ...over,
});

describe("expectedPosition", () => {
  it("moves forward with the server clock while playing", () => {
    expect(expectedPosition(host(), 1_004_500)).toBeCloseTo(34.5);
  });
  it("stands still while paused", () => {
    expect(expectedPosition(host({ playing: false }), 1_060_000)).toBe(30);
  });
  it("never runs past the end of the track or backwards", () => {
    expect(expectedPosition(host({ position: 199 }), 1_100_000)).toBe(200);
    expect(expectedPosition(host(), 999_000)).toBe(30);
  });
});

describe("clockOffset", () => {
  it("is zero without samples", () => {
    expect(clockOffset([])).toBe(0);
  });
  it("trusts the fastest round trip", () => {
    // Our clock is 500 ms behind the server. The slow sample is skewed by a lopsided delay.
    const samples = [
      { sent: 1000, received: 1400, serverNow: 1_000 + 500 + 350 },
      { sent: 2000, received: 2020, serverNow: 2010 + 500 },
      { sent: 3000, received: 3200, serverNow: 3100 + 500 },
    ];
    expect(clockOffset(samples)).toBe(500);
  });
});

describe("correctDrift", () => {
  const ok = { canAdjustRate: true, sinceLastSeekMs: 10_000 };
  it("leaves tiny drift alone", () => {
    expect(correctDrift(0.1, ok)).toEqual({ kind: "none", rate: 1 });
    expect(correctDrift(-DRIFT.ignore, ok)).toEqual({ kind: "none", rate: 1 });
  });
  it("slows down when ahead and speeds up when behind", () => {
    const ahead = correctDrift(0.8, ok);
    const behind = correctDrift(-0.8, ok);
    expect(ahead.kind).toBe("rate");
    expect(ahead.rate).toBeLessThan(1);
    expect(behind.rate).toBeGreaterThan(1);
    expect(ahead.rate).toBeCloseTo(0.95, 2);
  });
  it("never changes speed by more than the limit", () => {
    const fix = correctDrift(1.9, ok);
    expect(Math.abs(fix.rate - 1)).toBeLessThanOrEqual(DRIFT.maxRateChange + 1e-9);
  });
  it("jumps when the drift is large", () => {
    expect(correctDrift(3, ok)).toEqual({ kind: "seek", rate: 1 });
    expect(correctDrift(-5, ok)).toEqual({ kind: "seek", rate: 1 });
  });
  it("holds back repeated jumps while the last one settles", () => {
    expect(correctDrift(3, { canAdjustRate: true, sinceLastSeekMs: 1000 }).kind).toBe("rate");
    expect(correctDrift(3, { canAdjustRate: false, sinceLastSeekMs: 1000 }).kind).toBe("none");
  });
  it("jumps earlier when it cannot change speed, and ignores small drift", () => {
    expect(correctDrift(1, { canAdjustRate: false, sinceLastSeekMs: 10_000 }).kind).toBe("seek");
    expect(correctDrift(0.5, { canAdjustRate: false, sinceLastSeekMs: 10_000 }).kind).toBe("none");
  });
});

describe("reconcile", () => {
  it("loads the host's track when ours differs", () => {
    expect(reconcile(host(), 31, { currentId: "other", isPlaying: true, position: 5 })).toEqual([{ type: "load" }]);
    expect(reconcile(host(), 31, { currentId: null, isPlaying: false, position: 0 })).toEqual([{ type: "load" }]);
  });
  it("pauses when the host has nothing playing", () => {
    expect(reconcile(host({ trackId: null }), 0, { currentId: "t1", isPlaying: true, position: 5 })).toEqual([{ type: "pause" }]);
    expect(reconcile(host({ trackId: null }), 0, { currentId: "t1", isPlaying: false, position: 5 })).toEqual([]);
  });
  it("matches play and pause", () => {
    expect(reconcile(host(), 31, { currentId: "t1", isPlaying: false, position: 31 })).toEqual([{ type: "play" }]);
    expect(reconcile(host({ playing: false }), 30, { currentId: "t1", isPlaying: true, position: 30 })).toEqual([{ type: "pause" }]);
  });
  it("seeks when the host jumped, before resuming", () => {
    expect(reconcile(host(), 120, { currentId: "t1", isPlaying: false, position: 31 })).toEqual([{ type: "seek", to: 120 }, { type: "play" }]);
  });
  it("does nothing when already in step", () => {
    expect(reconcile(host(), 31, { currentId: "t1", isPlaying: true, position: 31.4 })).toEqual([]);
  });
});

describe("describeDrift", () => {
  it("reads naturally", () => {
    expect(describeDrift(0.1)).toBe("In sync");
    expect(describeDrift(0.84)).toBe("0.8 s ahead");
    expect(describeDrift(-3)).toBe("3.0 s behind");
    expect(describeDrift(-42.4)).toBe("42 s behind");
  });
});