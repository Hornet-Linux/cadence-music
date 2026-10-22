import { describe, expect, it, vi } from "vitest";
import type { Lyrics, PluginStorage } from "../../types";
import type { Track } from "@/shared/types";
import { PersistentCache } from "../lyrics-view/cache";
import { isInstrumental } from "../lyrics-view/lrc";
import { cleanTitle, createLrclibProvider, LRCLIB_CLIENT, pickBest, recordToLyrics, type LrclibRecord } from "./lrclib";

const track = (over: Partial<Track> = {}): Track => ({
  id: "t1",
  title: "Bohemian Rhapsody",
  artists: [{ id: "a", name: "Queen" }],
  album: "A Night at the Opera",
  durationSec: 355,
  ...over,
});

const SYNCED = "[00:01.00]Is this the real life?\n[00:05.00]Is this just fantasy?";
const record = (over: Partial<LrclibRecord> = {}): LrclibRecord => ({
  trackName: "Bohemian Rhapsody",
  artistName: "Queen",
  albumName: "A Night at the Opera",
  duration: 355,
  instrumental: false,
  plainLyrics: "Is this the real life?\nIs this just fantasy?",
  syncedLyrics: SYNCED,
  ...over,
});

function memoryStorage(): PluginStorage {
  const data = new Map<string, unknown>();
  return {
    get: <T>(k: string) => (data.has(k) ? (JSON.parse(JSON.stringify(data.get(k))) as T) : null),
    set: (k, v) => void data.set(k, JSON.parse(JSON.stringify(v))),
    remove: (k) => void data.delete(k),
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setup(handler: (url: URL) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => handler(new URL(String(input))));
  const cache = new PersistentCache<Lyrics>(memoryStorage(), "cache", { maxEntries: 10, maxBytes: 100_000, ttlMs: 60_000 });
  const provider = createLrclibProvider({ fetch: fetchMock as unknown as typeof fetch, cache });
  return { provider, fetchMock, cache };
}

describe("recordToLyrics", () => {
  it("prefers synced lyrics, then plain, then nothing", () => {
    expect(recordToLyrics(record())).toMatchObject({ synced: true, source: "LRCLIB", lines: [{ timeSec: 1 }, { timeSec: 5 }] });
    expect(recordToLyrics(record({ syncedLyrics: null }))).toMatchObject({ synced: false, lines: [{ text: "Is this the real life?" }, { text: "Is this just fantasy?" }] });
    expect(recordToLyrics(record({ syncedLyrics: "", plainLyrics: "" }))).toBeNull();
  });
  it("falls back to plain when the synced text has no timestamps", () => {
    expect(recordToLyrics(record({ syncedLyrics: "no stamps here" }))?.synced).toBe(false);
  });
  it("marks instrumentals", () => {
    expect(isInstrumental(recordToLyrics(record({ instrumental: true, plainLyrics: null, syncedLyrics: null })))).toBe(true);
  });
});

describe("cleanTitle and pickBest", () => {
  it("strips feature credits and remaster suffixes", () => {
    expect(cleanTitle("Song (feat. Someone)")).toBe("Song");
    expect(cleanTitle("Song - 2011 Remaster")).toBe("Song");
    expect(cleanTitle("Song [Live at Wembley]")).toBe("Song");
    expect(cleanTitle("Plain Title")).toBe("Plain Title");
  });
  it("chooses the matching song, close in length, with synced words", () => {
    const hits = [
      record({ id: 1, artistName: "Other Band", syncedLyrics: SYNCED }),
      record({ id: 2, duration: 200 }),
      record({ id: 3, syncedLyrics: null }),
      record({ id: 4, duration: 356 }),
      record({ id: 5, trackName: "Something Else" }),
    ];
    expect(pickBest(hits, track())?.id).toBe(4);
  });
  it("returns null when nothing fits", () => {
    expect(pickBest([record({ artistName: "Nobody" })], track())).toBeNull();
    expect(pickBest([], track())).toBeNull();
  });
});

describe("createLrclibProvider", () => {
  it("uses the exact get endpoint and sends the client header", async () => {
    const { provider, fetchMock } = setup(() => json(record()));
    const lyrics = await provider.getLyrics(track());
    expect(lyrics?.synced).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.pathname).toBe("/api/get");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      track_name: "Bohemian Rhapsody",
      artist_name: "Queen",
      album_name: "A Night at the Opera",
      duration: "355",
    });
    expect((init.headers as Record<string, string>)["Lrclib-Client"]).toBe(LRCLIB_CLIENT);
  });

  it("falls back to search on a 404 and picks the best hit", async () => {
    const { provider, fetchMock } = setup((url) =>
      url.pathname.endsWith("/get") ? json({ message: "not found" }, 404) : json([record({ id: 9, artistName: "Wrong" }), record({ id: 7 })]),
    );
    const lyrics = await provider.getLyrics(track({ title: "Bohemian Rhapsody (2011 Remaster)" }));
    expect(lyrics?.synced).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const search = new URL((fetchMock.mock.calls[1] as unknown as [string])[0]);
    expect(search.pathname).toBe("/api/search");
    expect(search.searchParams.get("track_name")).toBe("Bohemian Rhapsody");
  });

  it("searches by text when the track has no artist", async () => {
    const { provider, fetchMock } = setup((url) => (url.pathname.endsWith("/search") ? json([record()]) : json({}, 404)));
    await provider.getLyrics(track({ artists: [] }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL((fetchMock.mock.calls[0] as unknown as [string])[0]).searchParams.get("q")).toBe("Bohemian Rhapsody");
  });

  it("returns an instrumental marker", async () => {
    const { provider } = setup(() => json(record({ instrumental: true, plainLyrics: null, syncedLyrics: null })));
    expect(isInstrumental(await provider.getLyrics(track()))).toBe(true);
  });

  it("returns null when nothing is found, and remembers that", async () => {
    const { provider, fetchMock } = setup((url) => (url.pathname.endsWith("/search") ? json([]) : json({}, 404)));
    expect(await provider.getLyrics(track())).toBeNull();
    const calls = fetchMock.mock.calls.length;
    expect(await provider.getLyrics(track())).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("serves repeat requests from the cache, and fresh asks again", async () => {
    const { provider, fetchMock } = setup(() => json(record()));
    await provider.getLyrics(track());
    await provider.getLyrics(track());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await provider.getLyrics(track(), undefined, { fresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares one request between simultaneous callers", async () => {
    const { provider, fetchMock } = setup(() => json(record()));
    const [a, b] = await Promise.all([provider.getLyrics(track()), provider.getLyrics(track())]);
    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on server errors and does not cache them", async () => {
    let fail = true;
    const { provider, fetchMock } = setup(() => (fail ? json({}, 500) : json(record())));
    await expect(provider.getLyrics(track())).rejects.toThrow(/500/);
    fail = false;
    expect((await provider.getLyrics(track()))?.synced).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("explains rate limiting", async () => {
    const { provider } = setup(() => json({}, 429));
    await expect(provider.getLyrics(track())).rejects.toThrow(/busy/);
  });

  it("passes the abort signal to fetch", async () => {
    const { provider, fetchMock } = setup(() => json(record()));
    const controller = new AbortController();
    await provider.getLyrics(track(), controller.signal);
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBe(controller.signal);
  });

  it("does nothing for a track with no title", async () => {
    const { provider, fetchMock } = setup(() => json(record()));
    expect(await provider.getLyrics(track({ title: "  " }))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
