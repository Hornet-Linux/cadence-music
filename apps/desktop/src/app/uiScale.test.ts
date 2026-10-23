import { describe, expect, it } from "vitest";
import { DEFAULT_SCALE, normalizeScale, stepScale, zoomKeyAction } from "./uiScale";

const key = (k: string, o: object = {}) => ({ key: k, ctrlKey: true, metaKey: false, altKey: false, ...o });

describe("uiScale", () => {
  it("normalizes junk to the default and snaps to a step", () => {
    expect(normalizeScale(undefined)).toBe(DEFAULT_SCALE);
    expect(normalizeScale("abc")).toBe(DEFAULT_SCALE);
    expect(normalizeScale("1.24")).toBe(1.25);
    expect(normalizeScale(9)).toBe(1.5);
    expect(normalizeScale(0.1)).toBe(0.8);
  });
  it("steps within the range", () => {
    expect(stepScale(1, 1)).toBe(1.1);
    expect(stepScale(1, -1)).toBe(0.9);
    expect(stepScale(1.5, 1)).toBe(1.5);
    expect(stepScale(0.8, -1)).toBe(0.8);
  });
  it("maps the zoom shortcuts", () => {
    expect(zoomKeyAction(key("="))).toBe("in");
    expect(zoomKeyAction(key("+", { ctrlKey: false, metaKey: true }))).toBe("in");
    expect(zoomKeyAction(key("-"))).toBe("out");
    expect(zoomKeyAction(key("0"))).toBe("reset");
    expect(zoomKeyAction(key("=", { ctrlKey: false }))).toBeNull();
    expect(zoomKeyAction(key("a"))).toBeNull();
    expect(zoomKeyAction(key("-", { altKey: true }))).toBeNull();
  });
});
