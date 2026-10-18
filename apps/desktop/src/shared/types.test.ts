import { describe, expect, it } from "vitest";
import { formatDuration, primaryArtist, type Track } from "./types";

describe("formatDuration", () => {
  it("formats seconds as m:ss", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(5)).toBe("0:05");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(600)).toBe("10:00");
  });

  it("handles unknown and invalid values", () => {
    expect(formatDuration(undefined)).toBe("--:--");
    expect(formatDuration(NaN)).toBe("--:--");
    expect(formatDuration(-10)).toBe("0:00");
  });
});

describe("primaryArtist", () => {
  const base: Omit<Track, "artists"> = { id: "t", title: "Song" };

  it("joins multiple artists", () => {
    expect(primaryArtist({ ...base, artists: [{ id: "1", name: "A" }, { id: "2", name: "B" }] })).toBe(
      "A, B",
    );
  });

  it("falls back when there are no artists", () => {
    expect(primaryArtist({ ...base, artists: [] })).toBe("Unknown artist");
  });
});
