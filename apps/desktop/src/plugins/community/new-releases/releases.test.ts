import { describe, expect, it, vi } from "vitest";
import { MetadataError, type MetadataClient } from "../_metadata/client";
import type { ReleaseGroupInfo } from "../_metadata/types";
import { findNewReleases, isFresh, mergeReleases, withoutDismissed } from "./releases";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const rg = (mbid: string, artist: string, title: string, date: string): ReleaseGroupInfo => ({
  mbid,
  artist,
  title,
  date,
  type: "Album",
  coverUrl: "https://coverartarchive.org/release-group/" + mbid + "/front-250",
});

describe("mergeReleases", () => {
  it("keeps the last 90 days, newest first, one row per release", () => {
    const merged = mergeReleases(
      [
        [rg("1", "A", "Newer", "2026-10-10"), rg("2", "A", "Old", "2026-05-01")],
        [rg("3", "B", "Mid", "2026-09-01"), rg("1", "A", "Newer", "2026-10-10"), rg("9", "B", "mid", "2026-09-01")],
      ],
      NOW,
    );
    expect(merged.map((r) => r.title)).toEqual(["Newer", "Mid"]);
  });

  it("ignores vague dates and releases far in the future", () => {
    const merged = mergeReleases([[rg("1", "A", "Year only", "2026"), rg("2", "A", "Month only", "2026-10"), rg("3", "A", "Far away", "2027-03-01"), rg("4", "A", "Soon", "2026-10-25")]], NOW);
    expect(merged.map((r) => r.title)).toEqual(["Soon"]);
  });
});

describe("withoutDismissed", () => {
  it("hides dismissed items and caps the list", () => {
    const items = Array.from({ length: 20 }, (_, i) => rg(String(i), "A", "T" + i, "2026-10-01"));
    expect(withoutDismissed(items, ["0", "1"]).map((i) => i.mbid)).not.toContain("0");
    expect(withoutDismissed(items, [])).toHaveLength(12);
  });
});

describe("findNewReleases", () => {
  const artists = [
    { name: "A", plays: 3 },
    { name: "B", plays: 2 },
    { name: "C", plays: 1 },
  ];

  it("asks for the 90 day window per artist and merges the answers", async () => {
    const client = {
      newReleases: vi.fn(async (name: string) => ({ items: name === "C" ? [] : [rg(name, name, name + " album", "2026-10-01")] })),
    } as unknown as MetadataClient;
    const result = await findNewReleases(client, artists, { now: NOW });
    expect(result.items.map((i) => i.artist).sort()).toEqual(["A", "B"]);
    expect(result).toMatchObject({ checked: 3, failed: 0 });
    expect(client.newReleases).toHaveBeenCalledWith("A", 90, undefined);
  });

  it("counts failures, not missing artists, and still returns what it found", async () => {
    const client = {
      newReleases: vi.fn(async (name: string) => {
        if (name === "A") throw new MetadataError("failed", "down");
        if (name === "B") throw new MetadataError("not_found", "none");
        return { items: [rg("c", "C", "C album", "2026-10-02")] };
      }),
    } as unknown as MetadataClient;
    const result = await findNewReleases(client, artists, { now: NOW });
    expect(result.failed).toBe(1);
    expect(result.items).toHaveLength(1);
  });

  it("reports progress as artists finish", async () => {
    const client = { newReleases: vi.fn(async () => ({ items: [] })) } as unknown as MetadataClient;
    const seen: number[] = [];
    await findNewReleases(client, artists, { now: NOW, onProgress: (r) => seen.push(r.checked) });
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe("isFresh", () => {
  it("accepts a recent result for the same artists only", () => {
    const stored = { key: "a|b", at: NOW - 3_600_000, items: [] };
    expect(isFresh(stored, "a|b", NOW)).toBe(true);
    expect(isFresh(stored, "a|c", NOW)).toBe(false);
    expect(isFresh({ ...stored, at: NOW - 7 * 3_600_000 }, "a|b", NOW)).toBe(false);
    expect(isFresh(null, "a|b", NOW)).toBe(false);
  });
});
