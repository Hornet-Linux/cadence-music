import { describe, expect, it } from "vitest";
import { coverInitial } from "./CoverArt";

describe("coverInitial", () => {
  it("skips leading digits and punctuation", () => {
    expect(coverInitial("01 Intro")).toBe("I");
    expect(coverInitial("(live) take")).toBe("L");
    expect(coverInitial("élan")).toBe("É");
  });
  it("falls back to a note glyph without letters", () => {
    expect(coverInitial("1999")).toBe("\u266A");
    expect(coverInitial("")).toBe("");
  });
});
