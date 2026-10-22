import { describe, expect, it, vi } from "vitest";
import { MetadataError, type MetadataClient } from "../_metadata/client";
import { buildAbout, factsFor, loadAbout } from "./about";

const region = (code: string) => ({ GB: "United Kingdom" })[code];
const artist = {
  mbid: "m",
  name: "Radiohead",
  type: "Group",
  country: "GB",
  beginYear: 1985,
  genres: ["alternative rock"],
  links: [{ label: "Website", url: "https://radiohead.com/" }],
};
const wiki = { title: "Radiohead", description: "English rock band", extract: "Radiohead are...", image: "https://img/w.jpg", url: "https://en.wikipedia.org/wiki/Radiohead" };

describe("factsFor", () => {
  it("lists type, country and start year", () => {
    expect(factsFor(artist, region)).toEqual(["Band", "United Kingdom", "since 1985"]);
  });
  it("is empty without MusicBrainz data", () => {
    expect(factsFor(undefined)).toEqual([]);
  });
});

describe("buildAbout", () => {
  it("prefers a Fanart photo, then the Wikipedia one, and puts Wikipedia first in the links", () => {
    const withFanart = buildAbout("Radiohead", { artist, wiki, fanart: { thumbs: ["https://f/t.jpg"], backgrounds: [], logos: [], banners: [] } }, region)!;
    expect(withFanart.image).toBe("https://f/t.jpg");
    expect(withFanart.links.map((l) => l.label)).toEqual(["Wikipedia", "Website"]);
    expect(withFanart.sources).toEqual(["Wikipedia", "MusicBrainz", "Fanart.tv"]);
    expect(buildAbout("Radiohead", { artist, wiki }, region)!.image).toBe("https://img/w.jpg");
  });

  it("works with only one source and returns null with none", () => {
    expect(buildAbout("X", { wiki })).toMatchObject({ name: "Radiohead", genres: [], facts: [] });
    expect(buildAbout("X", {})).toBeNull();
  });

  it("does not repeat a link and caps the list", () => {
    const many = { ...artist, links: Array.from({ length: 20 }, (_, i) => ({ label: "L" + i, url: "https://x.test/" + i })) };
    const built = buildAbout("X", { artist: many, wiki: { ...wiki, url: "https://x.test/0" } })!;
    expect(built.links).toHaveLength(8);
    expect(new Set(built.links.map((l) => l.url)).size).toBe(8);
  });
});

describe("loadAbout", () => {
  const client = (parts: { artist?: unknown; wikipedia?: unknown; fanart?: unknown }) =>
    ({
      artist: vi.fn(async () => (parts.artist instanceof Error ? Promise.reject(parts.artist) : parts.artist)),
      wikipedia: vi.fn(async () => (parts.wikipedia instanceof Error ? Promise.reject(parts.wikipedia) : parts.wikipedia)),
      fanart: vi.fn(async () => (parts.fanart instanceof Error ? Promise.reject(parts.fanart) : parts.fanart)),
    }) as unknown as MetadataClient;

  it("ignores a Fanart key that is not set", async () => {
    const about = await loadAbout(client({ artist, wikipedia: wiki, fanart: new MetadataError("not_configured", "no key") }), "Radiohead");
    expect(about.name).toBe("Radiohead");
    expect(about.sources).toEqual(["Wikipedia", "MusicBrainz"]);
  });

  it("reports not_found when nobody knows the artist", async () => {
    const nf = new MetadataError("not_found", "none");
    await expect(loadAbout(client({ artist: nf, wikipedia: nf, fanart: nf }), "Nobody")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("reports a real problem over not_found", async () => {
    await expect(
      loadAbout(client({ artist: new MetadataError("failed", "down"), wikipedia: new MetadataError("not_found", "none"), fanart: new MetadataError("not_found", "x") }), "A"),
    ).rejects.toMatchObject({ kind: "failed" });
  });
});
