import { describe, expect, it } from "vitest";
import { PRESETS } from "./store";

describe("S3 presets", () => {
  it("fill in regions the server accepts and endpoints it can parse", () => {
    for (const p of PRESETS) {
      expect(p.region, p.id).toMatch(/^[A-Za-z0-9-]{2,40}$/);
      if (p.endpoint) expect(() => new URL(p.endpoint), p.id).not.toThrow();
      expect(p.help.length, p.id).toBeGreaterThan(20);
    }
  });

  it("start with Amazon S3 (no endpoint) and have unique ids", () => {
    expect(PRESETS[0]!.id).toBe("aws");
    expect(PRESETS[0]!.endpoint).toBe("");
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
  });
});
