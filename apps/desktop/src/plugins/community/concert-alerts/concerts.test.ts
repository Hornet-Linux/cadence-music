import { describe, expect, it, vi } from "vitest";
import { MetadataError, type MetadataClient } from "../_metadata/client";
import type { ConcertInfo } from "../_metadata/types";
import { findConcerts, locationText, parseLocation, upcomingShows } from "./concerts";

const NOW = Date.parse("2026-10-22T12:00:00");
const show = (artist: string, datetime: string, venue = "Hall", id = artist + datetime): ConcertInfo => ({
  id,
  artist,
  datetime,
  venue,
  city: "London",
  country: "United Kingdom",
  lineup: [],
});

describe("parseLocation", () => {
  it("reads a city and an optional country", () => {
    expect(parseLocation("Paris")).toEqual({ city: "Paris", country: undefined });
    expect(parseLocation(" Paris , France ")).toEqual({ city: "Paris", country: "France" });
    expect(locationText({ city: "Paris", country: "France" })).toBe("Paris, France");
  });
  it("rejects empty or silly input", () => {
    expect(parseLocation("  ")).toBeNull();
    expect(parseLocation(",")).toBeNull();
    expect(parseLocation("x".repeat(100))).toBeNull();
  });
});

describe("upcomingShows", () => {
  it("drops past shows, sorts soonest first and removes duplicates", () => {
    const shows = [
      show("B", "2026-12-05T20:00:00"),
      show("A", "2026-11-01T20:00:00"),
      show("A", "2026-11-01T21:00:00", "Hall", "dupe"),
      show("Old", "2026-09-01T20:00:00"),
      show("Bad", "not a date"),
    ];
    expect(upcomingShows(shows, NOW).map((s) => s.artist)).toEqual(["A", "B"]);
  });

  it("keeps a show from earlier today", () => {
    expect(upcomingShows([show("Tonight", "2026-10-22T09:00:00")], NOW)).toHaveLength(1);
  });

  it("limits the list", () => {
    const many = Array.from({ length: 30 }, (_, i) => show("A" + i, "2026-12-" + String((i % 28) + 1).padStart(2, "0") + "T20:00:00"));
    expect(upcomingShows(many, NOW, 5)).toHaveLength(5);
  });
});

describe("findConcerts", () => {
  const artists = [
    { name: "A", plays: 3 },
    { name: "B", plays: 2 },
    { name: "C", plays: 1 },
  ];

  it("collects shows near the city and reports progress", async () => {
    const client = {
      events: vi.fn(async (name: string) => ({ items: name === "C" ? [] : [show(name, "2026-11-01T20:00:00")] })),
    } as unknown as MetadataClient;
    const progress: number[] = [];
    const result = await findConcerts(client, artists, { city: "London" }, { now: NOW, onProgress: (r) => progress.push(r.checked) });
    expect(result.shows.map((s) => s.artist).sort()).toEqual(["A", "B"]);
    expect(result).toMatchObject({ checked: 3, failed: 0, notConfigured: false });
    expect(progress).toEqual([1, 2, 3]);
    expect(client.events).toHaveBeenCalledWith("A", "London", undefined, undefined);
  });

  it("stops early and says so when the Bandsintown id is missing", async () => {
    const client = { events: vi.fn(async () => Promise.reject(new MetadataError("not_configured", "no id"))) } as unknown as MetadataClient;
    const result = await findConcerts(client, artists, { city: "London" }, { now: NOW });
    expect(result.notConfigured).toBe(true);
    expect(result.shows).toEqual([]);
    expect(vi.mocked(client.events).mock.calls.length).toBeLessThan(artists.length + 1);
  });

  it("counts real failures but not unknown artists", async () => {
    const client = {
      events: vi.fn(async (name: string) => {
        if (name === "A") throw new MetadataError("not_found", "x");
        if (name === "B") throw new MetadataError("failed", "down");
        return { items: [show("C", "2026-11-01T20:00:00")] };
      }),
    } as unknown as MetadataClient;
    const result = await findConcerts(client, artists, { city: "London" }, { now: NOW });
    expect(result).toMatchObject({ failed: 1, checked: 3 });
    expect(result.shows).toHaveLength(1);
  });
});
