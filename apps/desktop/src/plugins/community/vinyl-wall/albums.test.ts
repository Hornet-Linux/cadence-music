import { describe, expect, it } from "vitest";
import type { Track } from "@/shared/types";
import { filterAlbums, groupAlbums, pageOf, sortAlbums, staggerMs } from "./albums";

const t = (id: string, title: string, artist: string, album?: string, artwork?: string): Track => ({
  id,
  title,
  artists: [{ id: artist, name: artist }],
  album,
  artwork,
});

const tracks = [
  t("1", "Intro", "The Band", "First Light"),
  t("2", "Second", "The Band", "first light", "https://x/a.jpg"),
  t("3", "Single", "Solo Artist"),
  t("4", "Hits", "Alpha", "Greatest Hits"),
  t("5", "Hits", "Zeta", "Greatest Hits"),
  t("6", "Again", "Alpha", "A Second Album"),
  t("1", "Intro", "The Band", "First Light"), // the same track listed twice
];

describe("groupAlbums", () => {
  const albums = groupAlbums(tracks);
  it("groups tracks by album and artist, ignoring case and repeats", () => {
    const first = albums.find((a) => a.title === "First Light")!;
    expect(first.tracks.map((x) => x.id)).toEqual(["1", "2"]);
    expect(first.artwork).toBe("https://x/a.jpg");
  });
  it("keeps same-named albums by different artists apart", () => {
    expect(albums.filter((a) => a.title === "Greatest Hits")).toHaveLength(2);
  });
  it("puts tracks without an album under Singles for their artist", () => {
    const single = albums.find((a) => a.title === "Singles")!;
    expect(single.artist).toBe("Solo Artist");
  });
  it("copes with missing artists", () => {
    expect(groupAlbums([{ id: "x", title: "T", artists: [] }])[0].artist).toBe("Unknown artist");
    expect(groupAlbums([])).toEqual([]);
  });
});

describe("sorting and filtering", () => {
  const albums = groupAlbums(tracks);
  it("sorts by title, ignoring a leading article", () => {
    const titles = sortAlbums(albums, "title").map((a) => a.title);
    expect(titles.slice(0, 2)).toEqual(["First Light", "Greatest Hits"]);
    expect(titles).toContain("A Second Album");
    expect(titles.indexOf("A Second Album")).toBeGreaterThan(titles.indexOf("Greatest Hits") - 1);
  });
  it("sorts by artist, skipping The", () => {
    const artists = sortAlbums(albums, "artist").map((a) => a.artist);
    expect(artists[0]).toBe("Alpha");
    expect(artists.indexOf("The Band")).toBeLessThan(artists.indexOf("Zeta"));
  });
  it("sorts by number of tracks, biggest first", () => {
    expect(sortAlbums(albums, "size")[0].title).toBe("First Light");
  });
  it("does not change the list it is given", () => {
    const before = albums.map((a) => a.key);
    sortAlbums(albums, "size");
    expect(albums.map((a) => a.key)).toEqual(before);
  });
  it("filters on album, artist or a song in it", () => {
    expect(filterAlbums(albums, "zeta")).toHaveLength(1);
    expect(filterAlbums(albums, "  FIRST  ")).toHaveLength(1);
    expect(filterAlbums(albums, "second")).toHaveLength(2); // album "A Second Album" and the song "Second"
    expect(filterAlbums(albums, "")).toHaveLength(albums.length);
    expect(filterAlbums(albums, "nothing like this")).toEqual([]);
  });
});

describe("paging and motion helpers", () => {
  it("renders in pages", () => {
    const items = Array.from({ length: 130 }, (_, i) => i);
    expect(pageOf(items, 1)).toHaveLength(60);
    expect(pageOf(items, 3)).toHaveLength(130);
  });
  it("caps the fade-in delay", () => {
    expect(staggerMs(0)).toBe(0);
    expect(staggerMs(5)).toBe(150);
    expect(staggerMs(11)).toBe(330);
    expect(staggerMs(12)).toBe(0);
    expect(staggerMs(7, 100, 360)).toBe(360);
  });
});