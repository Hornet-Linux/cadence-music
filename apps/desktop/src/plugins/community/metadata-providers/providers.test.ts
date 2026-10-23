import { describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import { MetadataError, type MetadataClient } from "../_metadata/client";
import { discogsProvider, musicBrainzProvider, wikipediaProvider } from "./providers";

const track: Track = { id: "t", title: "Karma Police", artists: [{ id: "a", name: "Radiohead" }], album: "OK Computer" };

function fakeClient(parts: Partial<Record<keyof MetadataClient, unknown>>): MetadataClient {
  const fail = () => Promise.reject(new MetadataError("not_found", "none"));
  const pick = (name: keyof MetadataClient) => (name in parts ? vi.fn(async () => parts[name]) : vi.fn(fail));
  return {
    recording: pick("recording"),
    artist: pick("artist"),
    cover: pick("cover"),
    wikipedia: pick("wikipedia"),
    discogs: pick("discogs"),
    discogsRelease: pick("discogsRelease"),
  } as unknown as MetadataClient;
}

describe("MusicBrainz provider", () => {
  it("combines cover, year, genres and links", async () => {
    const client = fakeClient({
      recording: { year: 1997, genres: ["art rock"] },
      artist: { genres: ["alternative rock"], links: [{ label: "Website", url: "https://radiohead.com/" }] },
      cover: { url: "https://archive.org/c.jpg" },
    });
    const meta = await musicBrainzProvider(client).getMetadata(track);
    expect(meta).toEqual({
      artwork: "https://archive.org/c.jpg",
      year: 1997,
      genres: ["art rock"],
      links: [{ label: "Website", url: "https://radiohead.com/" }],
    });
  });

  it("falls back to the artist genres and survives missing parts", async () => {
    const client = fakeClient({ artist: { genres: ["rock"], links: [] } });
    expect(await musicBrainzProvider(client).getMetadata(track)).toEqual({ genres: ["rock"] });
  });

  it("returns null when nothing is known", async () => {
    expect(await musicBrainzProvider(fakeClient({})).getMetadata(track)).toBeNull();
  });

  it("returns null for a track without an artist and skips the cover without an album", async () => {
    const client = fakeClient({ recording: { year: 2000, genres: [] } });
    expect(await musicBrainzProvider(client).getMetadata({ ...track, artists: [] })).toBeNull();
    await musicBrainzProvider(client).getMetadata({ ...track, album: undefined });
    expect(client.cover).not.toHaveBeenCalled();
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(musicBrainzProvider(fakeClient({ artist: { genres: ["x"], links: [] } })).getMetadata(track, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("Wikipedia provider", () => {
  it("gives the biography and a link, trimmed to a sensible length", async () => {
    const client = fakeClient({ wikipedia: { extract: "x".repeat(3000), url: "https://en.wikipedia.org/wiki/Radiohead" } });
    const meta = await wikipediaProvider(client).getMetadata(track);
    expect(meta?.about?.length).toBeLessThan(1210);
    expect(meta?.about?.endsWith("...")).toBe(true);
    expect(meta?.links).toEqual([{ label: "Wikipedia", url: "https://en.wikipedia.org/wiki/Radiohead" }]);
  });

  it("returns null when there is no article", async () => {
    expect(await wikipediaProvider(fakeClient({})).getMetadata(track)).toBeNull();
  });
});

describe("Discogs provider", () => {
  it("is quiet when the admin has not added a token", async () => {
    const client = {
      discogs: vi.fn(async () => Promise.reject(new MetadataError("not_configured", "needs token"))),
      discogsRelease: vi.fn(async () => Promise.reject(new MetadataError("not_configured", "needs token"))),
    } as unknown as MetadataClient;
    expect(await discogsProvider(client).getMetadata(track)).toBeNull();
  });

  it("combines profile, year, genres and styles", async () => {
    const client = fakeClient({
      discogs: { profile: "English rock band.", url: "https://www.discogs.com/artist/1", links: [] },
      discogsRelease: { items: [{ year: 1997, genres: ["Rock"], styles: ["Alternative Rock"] }] },
    });
    const meta = await discogsProvider(client).getMetadata(track);
    expect(meta).toMatchObject({ about: "English rock band.", year: 1997, genres: ["Rock", "Alternative Rock"] });
    expect(meta?.links?.[0]).toEqual({ label: "Discogs", url: "https://www.discogs.com/artist/1" });
  });
});
