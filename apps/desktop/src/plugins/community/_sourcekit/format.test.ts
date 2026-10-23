import { describe, expect, it } from "vitest";
import { clock, dayLabel, fraction, rewindSeconds, speedLabel, spoken, stepSpeed } from "./format";
import { query } from "./api";

describe("format", () => {
  it("clock", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(65)).toBe("1:05");
    expect(clock(3723.9)).toBe("1:02:03");
    expect(clock(-1)).toBe("");
    expect(clock(undefined)).toBe("");
    expect(clock(Number.NaN)).toBe("");
  });
  it("spoken", () => {
    expect(spoken(20)).toBe("<1 min");
    expect(spoken(60 * 42)).toBe("42 min");
    expect(spoken(3600)).toBe("1 h");
    expect(spoken(3600 + 5 * 60)).toBe("1 h 5 min");
    expect(spoken(0)).toBe("");
  });
  it("dayLabel", () => {
    const now = new Date(2024, 5, 15, 12).getTime();
    expect(dayLabel(new Date(2024, 5, 15, 3).getTime(), now)).toBe("Today");
    expect(dayLabel(new Date(2024, 5, 14, 23).getTime(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2024, 5, 12).getTime(), now)).toBe("3 days ago");
    expect(dayLabel(new Date(2024, 2, 1).getTime(), now)).toMatch(/1/);
    expect(dayLabel(new Date(2021, 2, 1).getTime(), now)).toMatch(/2021/);
    expect(dayLabel(null)).toBe("");
  });
  it("speeds", () => {
    expect(speedLabel(1)).toBe("1.0×");
    expect(speedLabel(1.5)).toBe("1.5×");
    expect(stepSpeed(1, 1)).toBe(1.2);
    expect(stepSpeed(1, -1)).toBe(0.8);
    expect(stepSpeed(2, 1)).toBe(2);
    expect(stepSpeed(0.8, -1)).toBe(0.8);
    expect(stepSpeed(1.3, 1)).toBe(1.75);
  });
  it("smart rewind grows with the break", () => {
    expect(rewindSeconds(5_000)).toBe(0);
    expect(rewindSeconds(2 * 60_000)).toBe(3);
    expect(rewindSeconds(20 * 60_000)).toBe(8);
    expect(rewindSeconds(5 * 3600_000)).toBe(15);
  });
  it("fraction", () => {
    expect(fraction(50, 200)).toBe(0.25);
    expect(fraction(500, 200)).toBe(1);
    expect(fraction(5, 0)).toBe(0);
    expect(fraction(Number.NaN, 10)).toBe(0);
  });
  it("query drops empty values and encodes the rest", () => {
    expect(query({ q: "a b&c", page: 2, none: undefined, empty: "", flag: true, off: false })).toBe("?q=a+b%26c&page=2&flag=1");
    expect(query({})).toBe("");
  });
});