import { describe, expect, it } from "vitest";
import type { Play } from "@uma/shared";
import type { Track } from "@/shared/types";
import { artistsKey, rankArtists } from "./artists";

const play = (artist: string, at = 1, extra: string[] = []): Play => ({
  playedAt: at,
  track: { id: "t" + at + artist, title: "Song", artists: [artist, ...extra].map((name) => ({ id: name, name })) },
});

describe("rankArtists", () => {
  it("ranks by plays and ignores case", () => {
    const plays = [play("Radiohead", 1), play("radiohead", 2), play("Bjork", 3), play("Radiohead", 4)];
    expect(rankArtists(plays, [], 5)).toEqual([
      { name: "Radiohead", plays: 3 },
      { name: "Bjork", plays: 1 },
    ]);
  });

  it("counts every credited artist and skips placeholders", () => {
    const plays = [play("A", 1, ["B"]), play("Unknown Artist", 2), play("Various Artists", 3)];
    expect(rankArtists(plays, [], 5).map((a) => a.name)).toEqual(["A", "B"]);
  });

  it("uses library artists only as a small tiebreaker below real plays", () => {
    const library: Track[] = [
      { id: "1", title: "x", artists: [{ id: "l", name: "Library Band" }] },
      { id: "2", title: "y", artists: [{ id: "p", name: "Played" }] },
    ];
    const ranked = rankArtists([play("Played", 1)], library, 5);
    expect(ranked[0].name).toBe("Played");
    expect(ranked.map((a) => a.name)).toContain("Library Band");
  });

  it("limits the list", () => {
    const plays = ["A", "B", "C", "D"].map((a, i) => play(a, i + 1));
    expect(rankArtists(plays, [], 2)).toHaveLength(2);
  });

  it("builds a stable key", () => {
    expect(artistsKey([{ name: "A B", plays: 1 }, { name: "C", plays: 2 }])).toBe("a b|c");
  });
});
