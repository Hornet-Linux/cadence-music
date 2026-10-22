import { describe, expect, it } from "vitest";
import type { Track } from "@/shared/types";
import {
  chosenTrack,
  decodeText,
  defaultChoice,
  makeRow,
  searchTracks,
  spotifyItemToRow,
  statusOf,
  summarize,
  topByPlays,
  type MatchCandidate,
} from "./logic";

const track = (id: string, title = id, artist = "A"): Track => ({ id, title, artists: [{ id: artist, name: artist }], source: "server" });
const cand = (id: string, confidence: MatchCandidate["confidence"], score = 0.9, source: "server" | "extra" = "server"): MatchCandidate => ({
  id,
  confidence,
  score,
  source,
  track: source === "server" ? track(`server:${id}`) : undefined,
});

describe("playlist importer logic", () => {
  it("decodes UTF-8 and UTF-16 files", () => {
    const utf8 = new TextEncoder().encode("Name\tArtist\nSong\tBjörk").buffer as ArrayBuffer;
    expect(decodeText(utf8)).toContain("Björk");
    const text = "Name\tArtist\nSong\tBjörk";
    const le = new Uint8Array(2 + text.length * 2);
    le.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) {
      le[2 + i * 2] = text.charCodeAt(i) & 255;
      le[3 + i * 2] = text.charCodeAt(i) >> 8;
    }
    expect(decodeText(le.buffer)).toBe(text);
  });

  it("pre-selects sure matches, offers doubtful ones for review and skips the rest", () => {
    expect(defaultChoice([cand("a", "high")])).toBe(0);
    expect(defaultChoice([cand("a", "medium")])).toBe(0);
    expect(defaultChoice([cand("a", "low")])).toBe("skip");
    expect(defaultChoice([])).toBe("skip");
    expect(defaultChoice([cand("a", "low")], track("spotify:track:1"))).toBe("original");
    expect(defaultChoice([cand("a", "high")], track("spotify:track:1"))).toBe(0);
  });

  it("reports a status per row", () => {
    const wanted = { title: "T", artists: ["A"] };
    expect(statusOf(makeRow(1, wanted, [cand("a", "high")]))).toBe("matched");
    expect(statusOf(makeRow(2, wanted, [cand("a", "medium")]))).toBe("review");
    expect(statusOf(makeRow(3, wanted, []))).toBe("missing");
    expect(statusOf({ ...makeRow(4, wanted, []), choice: "manual", manual: track("m") })).toBe("matched");
    expect(statusOf(makeRow(5, wanted, [], track("spotify:track:1")))).toBe("original");
  });

  it("finds the track a row will add, from the server or from another source", () => {
    const lookup = (id: string) => (id === "spotify:track:9" ? track("spotify:track:9") : undefined);
    expect(chosenTrack(makeRow(1, { title: "T", artists: [] }, [cand("a", "high")]), lookup)?.id).toBe("server:a");
    expect(chosenTrack(makeRow(2, { title: "T", artists: [] }, [cand("spotify:track:9", "high", 0.9, "extra")]), lookup)?.id).toBe("spotify:track:9");
    expect(chosenTrack(makeRow(3, { title: "T", artists: [] }, [cand("missing", "high", 0.9, "extra")]), lookup)).toBeNull();
    expect(chosenTrack({ ...makeRow(4, { title: "T", artists: [] }, []), choice: "skip" }, lookup)).toBeNull();
  });

  it("summarises the preview and never adds the same track twice", () => {
    const rows = [
      makeRow(1, { title: "A", artists: [] }, [cand("a", "high")]),
      makeRow(2, { title: "A again", artists: [] }, [cand("a", "high")]),
      makeRow(3, { title: "B", artists: [] }, [cand("b", "medium")]),
      makeRow(4, { title: "C", artists: [] }, []),
      makeRow(5, { title: "D", artists: [] }, [], track("spotify:track:d")),
    ];
    const s = summarize(rows, () => undefined);
    expect(s).toMatchObject({ total: 5, matched: 2, review: 1, missing: 1, original: 1 });
    expect(s.tracks.map((t) => t.id)).toEqual(["server:a", "server:b", "spotify:track:d"]);
  });

  it("searches by every word in title, artist or album, ignoring accents", () => {
    const tracks = [
      { ...track("1", "Hyperballad", "Björk"), album: "Post" },
      { ...track("2", "Army of Me", "Björk"), album: "Post" },
      track("3", "Hyperballad", "Someone Else"),
    ];
    expect(searchTracks(tracks, "bjork hyper").map((t) => t.id)).toEqual(["1"]);
    expect(searchTracks(tracks, "post").map((t) => t.id)).toEqual(["1", "2"]);
    expect(searchTracks(tracks, "  ")).toEqual([]);
    expect(searchTracks(tracks, "hyperballad", 1)).toHaveLength(1);
  });

  it("turns a Spotify playlist item into a wanted track and a playable original", () => {
    const row = spotifyItemToRow({
      track: { uri: "spotify:track:abc", name: "Teardrop", duration_ms: 330000, artists: [{ id: "x", name: "Massive Attack" }], album: { name: "Mezzanine", images: [{ url: "https://i/300", width: 300 }, { url: "https://i/640", width: 640 }] } },
    })!;
    expect(row.wanted).toEqual({ title: "Teardrop", artists: ["Massive Attack"], album: "Mezzanine", durationSec: 330 });
    expect(row.original).toMatchObject({ id: "spotify:track:abc", source: "spotify", artwork: "https://i/300" });
    expect(spotifyItemToRow({ track: null })).toBeNull();
    expect(spotifyItemToRow({ track: { uri: "spotify:local:x", name: "Local", duration_ms: 1, is_local: true, artists: [], album: { name: "" } } })).toBeNull();
    expect(spotifyItemToRow({ track: { uri: "spotify:episode:x", name: "Podcast", duration_ms: 1, artists: [], album: { name: "" } } })).toBeNull();
  });

  it("limits a history to the most played tracks, but leaves a playlist alone", () => {
    const history = [3, 2, 1].map((count, i) => ({ wanted: { title: `S${i}`, artists: [], count } }));
    expect(topByPlays(history, 2)).toHaveLength(2);
    const playlist = [1, 1, 1].map((count, i) => ({ wanted: { title: `S${i}`, artists: [], count } }));
    expect(topByPlays(playlist, 2)).toHaveLength(3);
  });
});