import { describe, expect, it } from "vitest";
import { fitLine, paletteFor, safeFileName, wrapLines } from "./canvasCard";

// A fake ruler: every character is 10 units wide.
const measure = (s: string) => s.length * 10;

describe("wrapLines", () => {
  it("wraps on word boundaries", () => {
    expect(wrapLines("one two three four", 80, measure, 5)).toEqual(["one two", "three", "four"]);
  });
  it("adds an ellipsis when there are too many lines", () => {
    const lines = wrapLines("alpha beta gamma delta epsilon", 60, measure, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith("\u2026")).toBe(true);
    expect(measure(lines[1])).toBeLessThanOrEqual(60);
  });
  it("breaks a word that is wider than the line", () => {
    const lines = wrapLines("abcdefghijkl", 50, measure, 5);
    expect(lines.every((l) => measure(l) <= 50)).toBe(true);
    expect(lines.join("")).toBe("abcdefghijkl");
  });
  it("returns nothing for empty text", () => {
    expect(wrapLines("   ", 100, measure, 2)).toEqual([]);
  });
});

describe("fitLine", () => {
  it("leaves short text alone and trims long text", () => {
    expect(fitLine("short", 100, measure)).toBe("short");
    const out = fitLine("a rather long title", 80, measure);
    expect(measure(out)).toBeLessThanOrEqual(80);
    expect(out.endsWith("\u2026")).toBe(true);
  });
});

describe("safeFileName and paletteFor", () => {
  it("makes safe file names", () => {
    expect(safeFileName("Beyonc\u00e9 / Halo?", "png")).toBe("beyonce-halo.png");
    expect(safeFileName("???", "png")).toBe("cadence.png");
    expect(safeFileName("x".repeat(200), "png").length).toBeLessThan(70);
  });
  it("gives the same calm palette for the same seed", () => {
    expect(paletteFor("abc")).toEqual(paletteFor("abc"));
    expect(paletteFor("abc").bgTop).not.toEqual(paletteFor("abd").bgTop);
  });
});