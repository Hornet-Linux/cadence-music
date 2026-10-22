import { describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import { buildDjMessages, cleanReply, timeOfDay } from "./prompt";
import { normalize, resolvePick, resolvePicks } from "./resolve";
import { buildTasteProfile, isEmptyProfile } from "./tasteProfile";

const apiTrack = (id: string, name: string, artist: string) => ({
  uri: `spotify:track:${id}`,
  name,
  duration_ms: 200_000,
  artists: [{ id: artist, name: artist }],
  album: { name: "Album", images: [] },
});

const liked: Track = { id: "spotify:track:L", title: "Liked Song", artists: [{ id: "x", name: "Liked Artist" }] };

describe("buildTasteProfile", () => {
  it("combines top artists, genres, tracks and recent plays", async () => {
    const get = vi.fn(async (route: string) => {
      if (route.startsWith("me/top/artists"))
        return { items: [{ name: "Radiohead", genres: ["art rock", "alt"] }, { name: "Portishead", genres: ["trip hop", "alt"] }] };
      if (route.startsWith("me/top/tracks")) return { items: [apiTrack("1", "Reckoner", "Radiohead")] };
      return { items: [{ track: apiTrack("2", "Roads", "Portishead") }] };
    }) as never;
    const p = await buildTasteProfile([liked], get);
    expect(p.topArtists).toEqual(["Radiohead", "Portishead", "Liked Artist"]);
    expect(p.genres[0]).toBe("alt");
    expect(p.topTracks).toEqual(["Radiohead – Reckoner", "Liked Artist – Liked Song"]);
    expect(p.recentTracks).toEqual(["Portishead – Roads"]);
  });

  it("falls back to liked songs when history scopes are missing", async () => {
    const get = vi.fn(async () => {
      throw new Error("Spotify request failed (403)");
    }) as never;
    const p = await buildTasteProfile([liked], get);
    expect(p.topArtists).toEqual(["Liked Artist"]);
    expect(isEmptyProfile(p)).toBe(false);
    expect(isEmptyProfile(await buildTasteProfile([], get))).toBe(true);
  });
});

describe("prompt", () => {
  const profile = { topArtists: ["Radiohead"], genres: [], topTracks: [], recentTracks: [] };

  it("includes the profile, mood, avoid list and count", () => {
    const [, user] = buildDjMessages(profile, {
      mood: "rainy",
      avoid: ["A – B"],
      count: 5,
      now: new Date(2026, 0, 1, 9),
      switchUp: true,
    });
    expect(user.content).toContain("- Radiohead");
    expect(user.content).toContain("rainy");
    expect(user.content).toContain("- A – B");
    expect(user.content).toContain("Pick 5 songs.");
    expect(user.content).toContain("morning");
    expect(user.content).toContain("Switch it up");
    expect(user.content).not.toContain("Genres");
  });

  it("maps hours to times of day", () => {
    expect(timeOfDay(new Date(2026, 0, 1, 2))).toBe("late night");
    expect(timeOfDay(new Date(2026, 0, 1, 22))).toBe("night");
  });

  it("drops malformed picks", () => {
    expect(cleanReply({ picks: [{ artist: " A ", title: "B", intro: "hi" }, { artist: "", title: "x" }, null] })).toEqual([
      { artist: "A", title: "B", intro: "hi" },
    ]);
    expect(cleanReply("nope")).toEqual([]);
  });
});

describe("resolve", () => {
  it("normalizes titles", () => {
    expect(normalize("Héroes (Remastered 2017)")).toBe("heroes");
    expect(normalize("Song - 2011 Remaster")).toBe("song");
    expect(normalize("Simon & Garfunkel")).toBe("simon and garfunkel");
  });

  it("matches a real track and rejects invented ones", async () => {
    const get = vi.fn(async () => ({
      tracks: { items: [apiTrack("1", "Reckoner (Live)", "Radiohead"), apiTrack("2", "Reckoner", "Someone Else")] },
    })) as never;
    expect((await resolvePick({ artist: "Radiohead", title: "Reckoner", intro: "" }, get))?.id).toBe("spotify:track:1");
    expect(await resolvePick({ artist: "Radiohead", title: "Made Up Song", intro: "" }, get)).toBeNull();
  });

  it("dedupes and skips already played tracks", async () => {
    const get = vi.fn(async (route: string) => {
      const q = decodeURIComponent(route);
      if (q.includes("One")) return { tracks: { items: [apiTrack("1", "One", "A")] } };
      return { tracks: { items: [apiTrack("2", "Two", "B")] } };
    }) as never;
    const picks = [
      { artist: "A", title: "One", intro: "first" },
      { artist: "A", title: "One", intro: "dupe" },
      { artist: "B", title: "Two", intro: "second" },
    ];
    const set = await resolvePicks(picks, ["spotify:track:2"], get);
    expect(set.map((s) => [s.track.id, s.intro])).toEqual([["spotify:track:1", "first"]]);
  });
});
