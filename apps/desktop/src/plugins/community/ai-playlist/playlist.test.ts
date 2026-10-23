import { describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import { matchInTracks, resolveAcross, type Lookup } from "@/features/dj/multiSource";
import {
  MAX_SONGS,
  buildPlaylist,
  buildPlaylistMessages,
  cleanPlaylistReply,
  cleanPrompt,
  requestedSongs,
} from "./playlist";

const track = (id: string, title: string, artist: string, source = "server"): Track => ({
  id,
  title,
  artists: [{ id: artist, name: artist }],
  source,
});

/** A source that has exactly these tracks. */
function lookupWith(label: string, tracks: Track[], connected = true): Lookup {
  return {
    id: label,
    label,
    connected: () => connected,
    find: async (picks) => matchInTracks(tracks, picks),
  };
}

describe("buildPlaylistMessages", () => {
  it("puts the request, the time of day and a taste hint in the prompt, and asks for extras", () => {
    const [system, user] = buildPlaylistMessages({
      prompt: "  rainy   Sunday\ncooking ",
      count: 10,
      taste: { topArtists: ["Nick Drake", "Bill Evans"], genres: ["folk"], topTracks: [], recentTracks: [] },
      now: new Date(2026, 5, 7, 15),
    });
    expect(system.role).toBe("system");
    expect(system.content).toMatch(/never invent songs/i);
    expect(user.content).toContain("Playlist request: rainy Sunday cooking");
    expect(user.content).toContain("afternoon");
    expect(user.content).toContain("Nick Drake, Bill Evans");
    expect(user.content).toContain("Name 16 songs.");
    expect(requestedSongs(10)).toBe(16);
  });

  it("leaves out taste when there is none, and bounds a long request", () => {
    const [, user] = buildPlaylistMessages({ prompt: "x".repeat(900), count: 5 });
    expect(user.content).not.toContain("Artists the listener likes");
    expect(user.content.split("\n")[0].length).toBeLessThan(260);
    expect(cleanPrompt("a".repeat(900))).toHaveLength(200);
  });

  it("caps the number of songs asked for", () => {
    const [, user] = buildPlaylistMessages({ prompt: "x", count: 500 });
    expect(user.content).toContain(`Name ${MAX_SONGS + 6} songs.`);
  });
});

describe("cleanPlaylistReply", () => {
  it("reads a well-formed reply", () => {
    const r = cleanPlaylistReply({
      title: "Slow Sunday",
      description: "Warm and unhurried.",
      songs: [{ artist: "Nick Drake", title: "Pink Moon", why: "Soft guitar for the kitchen." }],
    });
    expect(r).toEqual({
      title: "Slow Sunday",
      description: "Warm and unhurried.",
      songs: [{ artist: "Nick Drake", title: "Pink Moon", why: "Soft guitar for the kitchen." }],
    });
  });

  it("copes with garbage: wrong types, missing fields, duplicates, odd keys", () => {
    expect(cleanPlaylistReply(null)).toEqual({ title: "", description: "", songs: [] });
    expect(cleanPlaylistReply("just text")).toEqual({ title: "", description: "", songs: [] });
    expect(cleanPlaylistReply({ songs: "nope" }).songs).toEqual([]);
    expect(cleanPlaylistReply({ songs: [null, 5, {}, { artist: "A" }, { title: "T" }, { artist: 1, title: 2 }] }).songs).toEqual([]);
    const r = cleanPlaylistReply({
      tracks: [
        { artist: "A", song: "One", reason: "because" },
        { artist: "a", title: "ONE", why: "dupe" },
        { artist: "B\n\n", title: "Two\tX", why: 7 },
      ],
    });
    expect(r.songs).toEqual([
      { artist: "A", title: "One", why: "because" },
      { artist: "B", title: "Two X", why: "" },
    ]);
    // A bare array works too.
    expect(cleanPlaylistReply([{ artist: "A", title: "One" }]).songs).toHaveLength(1);
  });

  it("bounds lengths and the number of songs", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ artist: `Artist ${i}`, title: "t".repeat(1000), why: "w".repeat(1000) }));
    const r = cleanPlaylistReply({ title: "T".repeat(500), songs: many });
    expect(r.songs).toHaveLength(MAX_SONGS);
    expect(r.songs[0].title.length).toBeLessThanOrEqual(200);
    expect(r.songs[0].why.length).toBeLessThanOrEqual(240);
    expect(r.title.length).toBeLessThanOrEqual(80);
  });
});

describe("resolveAcross", () => {
  it("takes the first place that has the song, and asks later places only for the rest", async () => {
    const a = lookupWith("server", [track("server:1", "Pink Moon", "Nick Drake")]);
    const find = vi.fn(async (picks: { artist: string; title: string }[]) =>
      picks.map((p) => (p.title === "Blue in Green" ? track("sp:2", "Blue in Green", "Miles Davis", "spotify") : null)),
    );
    const b: Lookup = { id: "sp", label: "Spotify", connected: () => true, find };
    const out = await resolveAcross(
      [
        { artist: "Nick Drake", title: "Pink Moon" },
        { artist: "Miles Davis", title: "Blue in Green" },
        { artist: "Nobody", title: "Invented Song" },
      ],
      [a, b],
    );
    expect(out.map((r) => [r.track?.id ?? null, r.via ?? null])).toEqual([
      ["server:1", "server"],
      ["sp:2", "Spotify"],
      [null, null],
    ]);
    expect(find.mock.calls[0][0]).toHaveLength(2);
  });

  it("skips a place that fails", async () => {
    const bad: Lookup = { id: "x", label: "X", connected: () => true, find: async () => Promise.reject(new Error("down")) };
    const good = lookupWith("server", [track("server:1", "Song", "Artist")]);
    const out = await resolveAcross([{ artist: "Artist", title: "Song" }], [bad, good]);
    expect(out[0].track?.id).toBe("server:1");
  });
});

describe("matchInTracks", () => {
  it("matches despite remaster suffixes, accents and case", () => {
    const lib = [track("1", "Heroes (2017 Remaster)", "David Bowie"), track("2", "Café del Mar", "Energy 52")];
    const [a, b, c] = matchInTracks(lib, [
      { artist: "david bowie", title: "Heroes" },
      { artist: "Energy 52", title: "Cafe del Mar" },
      { artist: "David Bowie", title: "Lazarus" },
    ]);
    expect(a?.id).toBe("1");
    expect(b?.id).toBe("2");
    expect(c).toBeNull();
  });
});

describe("buildPlaylist", () => {
  const library = [
    track("server:1", "Pink Moon", "Nick Drake"),
    track("server:2", "Cello Song", "Nick Drake"),
    track("server:3", "Time of the Season", "The Zombies"),
  ];
  const reply = {
    title: "Slow Sunday",
    description: "Easy.",
    songs: [
      { artist: "Nick Drake", title: "Pink Moon", why: "Gentle." },
      { artist: "Imaginary Band", title: "Made Up Song", why: "I invented this." },
      { artist: "Nick Drake", title: "Cello Song", why: "Warm." },
      { artist: "Nick Drake", title: "Pink Moon", why: "again" },
    ],
  };

  it("keeps only songs that exist in a source, in order, and never the made-up ones", async () => {
    const steps: string[] = [];
    const built = await buildPlaylist(
      { prompt: "rainy Sunday cooking", count: 10 },
      { ask: async () => reply, lookups: () => [lookupWith("your server library", library)], onStep: (s) => steps.push(s) },
    );
    expect(built.title).toBe("Slow Sunday");
    expect(built.found.map((f) => f.track.id)).toEqual(["server:1", "server:2"]);
    expect(built.found[0]).toMatchObject({ why: "Gentle.", via: "your server library" });
    expect(built.missing).toEqual([{ artist: "Imaginary Band", title: "Made Up Song", why: "I invented this." }]);
    expect(steps).toEqual(["asking", "checking"]);
  });

  it("trims to the requested count", async () => {
    const built = await buildPlaylist(
      { prompt: "x", count: 1 },
      { ask: async () => reply, lookups: () => [lookupWith("lib", library)] },
    );
    expect(built.found).toHaveLength(1);
  });

  it("fails clearly when nothing is connected, the prompt is empty, the answer is garbage, or nothing exists", async () => {
    const ask = vi.fn(async () => reply);
    await expect(buildPlaylist({ prompt: "x", count: 5 }, { ask, lookups: () => [] })).rejects.toThrow(/Connect your Cadence server/);
    await expect(buildPlaylist({ prompt: "   ", count: 5 }, { ask, lookups: () => [lookupWith("l", library)] })).rejects.toThrow(/Describe the playlist/);
    expect(ask).not.toHaveBeenCalled();

    await expect(
      buildPlaylist({ prompt: "x", count: 5 }, { ask: async () => ({ nonsense: true }), lookups: () => [lookupWith("l", library)] }),
    ).rejects.toThrow(/didn't contain any songs/);

    await expect(
      buildPlaylist(
        { prompt: "x", count: 5 },
        { ask: async () => ({ songs: [{ artist: "Ghost", title: "Nothing", why: "" }] }), lookups: () => [lookupWith("l", library)] },
      ),
    ).rejects.toThrow(/None of the 1 songs/);
  });

  it("falls back to the request as the title when the model gives none", async () => {
    const built = await buildPlaylist(
      { prompt: "rainy Sunday", count: 5 },
      { ask: async () => ({ songs: [{ artist: "Nick Drake", title: "Pink Moon" }] }), lookups: () => [lookupWith("l", library)] },
    );
    expect(built.title).toBe("rainy Sunday");
  });

  it("propagates provider errors", async () => {
    await expect(
      buildPlaylist({ prompt: "x", count: 5 }, { ask: async () => Promise.reject(new Error("Couldn't reach Ollama")), lookups: () => [lookupWith("l", library)] }),
    ).rejects.toThrow(/Ollama/);
  });
});
