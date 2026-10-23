import { describe, expect, it } from "vitest";
import type { Track } from "@/shared/types";
import { MOODS } from "./mood";
import { buildStation, matchPicks, normalizeName, scoreTrack, topLibraryArtists, type TrackTags } from "./radio";

const song = (n: number, artist = `Artist ${n}`, title = `Song ${n}`, album = `Album ${n}`): Track => ({
  id: `server:${n}`,
  title,
  artists: [{ id: artist, name: artist }],
  album,
  source: "server",
});

function seeded(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe("scoreTrack", () => {
  it("rewards matching genre tags most", () => {
    const jazz = scoreTrack(song(1), { genres: ["Jazz"] }, MOODS.rainy);
    const rock = scoreTrack(song(2), { genres: ["Rock"] }, MOODS.rainy);
    expect(jazz).toBeGreaterThan(0);
    expect(rock).toBeLessThanOrEqual(0);
  });
  it("matches loosely on genre names (Lo-Fi Hip Hop, Smooth Jazz)", () => {
    expect(scoreTrack(song(1), { genres: ["Smooth Jazz"] }, MOODS.rainy)).toBeGreaterThan(0);
    expect(scoreTrack(song(1), { genres: ["Lo-Fi"] }, MOODS.night)).toBeGreaterThan(0);
  });
  it("uses tempo as a smaller hint", () => {
    const base = scoreTrack(song(1), { genres: ["Jazz"] }, MOODS.rainy);
    expect(scoreTrack(song(1), { genres: ["Jazz"], bpm: 70 }, MOODS.rainy)).toBeGreaterThan(base);
    expect(scoreTrack(song(1), { genres: ["Jazz"], bpm: 190 }, MOODS.rainy)).toBeLessThan(base);
  });
  it("matches whole words in names, not parts of words", () => {
    expect(scoreTrack(song(1, "A", "Rain on Me"), undefined, MOODS.rainy)).toBeGreaterThan(0);
    expect(scoreTrack(song(1, "A", "Training Day"), undefined, MOODS.rainy)).toBeLessThanOrEqual(0);
  });
  it("counts the person's own keywords", () => {
    expect(scoreTrack(song(1, "Mellow Yellow", "Anything"), undefined, MOODS.rainy, ["yellow"])).toBeGreaterThan(0);
    expect(scoreTrack(song(1), undefined, MOODS.rainy, ["  "])).toBe(0);
  });
});

describe("buildStation", () => {
  const library = [
    ...Array.from({ length: 20 }, (_, i) => song(i + 1, `Jazz Cat ${i}`)),
    ...Array.from({ length: 20 }, (_, i) => song(i + 100, `Rocker ${i}`)),
  ];
  const tags: Record<string, TrackTags> = {};
  for (let i = 1; i <= 20; i++) tags[`server:${i}`] = { genres: ["Jazz"] };
  for (let i = 100; i < 120; i++) tags[`server:${i}`] = { genres: ["Hard Rock"] };

  it("picks songs that fit the mood", () => {
    const rainy = buildStation(library, tags, MOODS.rainy, { size: 10, rng: seeded(3) });
    expect(rainy.queue).toHaveLength(10);
    expect(rainy.matched).toBe(10);
    expect(rainy.queue.every((t) => tags[t.id].genres[0] === "Jazz")).toBe(true);
    const stormy = buildStation(library, tags, MOODS.stormy, { size: 10, rng: seeded(3) });
    expect(stormy.queue.every((t) => tags[t.id].genres[0] === "Hard Rock")).toBe(true);
  });
  it("is repeatable with the same random source and varies with another", () => {
    const a = buildStation(library, tags, MOODS.rainy, { size: 8, rng: seeded(5) }).queue.map((t) => t.id);
    expect(buildStation(library, tags, MOODS.rainy, { size: 8, rng: seeded(5) }).queue.map((t) => t.id)).toEqual(a);
    expect(buildStation(library, tags, MOODS.rainy, { size: 8, rng: seeded(6) }).queue.map((t) => t.id)).not.toEqual(a);
  });
  it("fills the queue from the rest of the library when too few songs fit", () => {
    const few = buildStation(library, { "server:1": { genres: ["Jazz"] } }, MOODS.rainy, { size: 6, rng: seeded(2) });
    expect(few.queue).toHaveLength(6);
    expect(few.matched).toBe(1);
    expect(few.filler).toBe(5);
    expect(few.tagged).toBe(1);
  });
  it("works with no tags at all, using only words and filler", () => {
    const none = buildStation(library, {}, MOODS.rainy, { size: 5, rng: seeded(1) });
    expect(none.queue).toHaveLength(5);
    expect(none.matched).toBe(0);
  });
  it("limits songs per artist and never repeats a song", () => {
    const sameArtist = Array.from({ length: 12 }, (_, i) => song(i + 1, "One Band"));
    const t: Record<string, TrackTags> = Object.fromEntries(sameArtist.map((s) => [s.id, { genres: ["Jazz"] }]));
    const station = buildStation([...sameArtist, ...library.slice(20, 30)], t, MOODS.rainy, { size: 8, perArtist: 2, rng: seeded(4) });
    expect(station.queue.filter((x) => x.artists[0].name === "One Band")).toHaveLength(2);
    expect(new Set(station.queue.map((x) => x.id)).size).toBe(station.queue.length);
  });
  it("lifts the artist limit rather than return a short queue from a small library", () => {
    const one = Array.from({ length: 6 }, (_, i) => song(i + 1, "Solo"));
    expect(buildStation(one, {}, MOODS.rainy, { size: 6, perArtist: 2 }).queue).toHaveLength(6);
  });
  it("avoids songs from the last station when it can", () => {
    const first = buildStation(library, tags, MOODS.rainy, { size: 10, rng: seeded(8) });
    const second = buildStation(library, tags, MOODS.rainy, { size: 10, rng: seeded(9), avoid: new Set(first.queue.map((t) => t.id)) });
    expect(second.queue.some((t) => first.queue.some((f) => f.id === t.id))).toBe(false);
  });
  it("handles an empty library", () => {
    expect(buildStation([], {}, MOODS.rainy)).toEqual({ queue: [], matched: 0, filler: 0, tagged: 0 });
  });
});

describe("matching the AI's picks to the library", () => {
  const library = [song(1, "The Cure", "Lovesong"), song(2, "Radiohead", "Weird Fishes/Arpeggi"), song(3, "Björk", "Hyperballad (Remastered)")];
  it("finds songs despite accents, case and version suffixes", () => {
    const found = matchPicks(
      [
        { artist: "bjork", title: "Hyperballad" },
        { artist: "the cure", title: "LOVESONG" },
        { artist: "Nobody", title: "Not Here" },
      ],
      library,
    );
    expect(found.map((t) => t.id)).toEqual(["server:3", "server:1"]);
  });
  it("needs the artist to agree, and uses each song once", () => {
    expect(matchPicks([{ artist: "Someone Else", title: "Lovesong" }], library)).toEqual([]);
    expect(matchPicks([{ artist: "The Cure", title: "Lovesong" }, { artist: "The Cure", title: "Lovesong" }], library)).toHaveLength(1);
  });
  it("normalises names", () => {
    expect(normalizeName("Beyoncé – Halo (Live)")).toBe("beyonce halo");
    expect(normalizeName("Simon & Garfunkel")).toBe("simon and garfunkel");
  });
  it("lists the artists with the most songs", () => {
    const many = [song(1, "A"), song(2, "B"), song(3, "B"), song(4, "b"), song(5, "C")];
    expect(topLibraryArtists(many, 2)).toEqual(["B", "A"]);
  });
});