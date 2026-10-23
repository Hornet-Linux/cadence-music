import { describe, expect, it } from "vitest";
import { crumbs, NEVER_INDEXED, plainError, remoteId, StreamLinkCache, summarizeIndexing, timeAgo, toggleChoice, toTrack, type IndexingDto } from "./logic";

const dto = (extra = {}) => ({ id: "abc", title: "Song", artist: "Artist", album: "Album", albumArtist: null, trackNo: 1, durationSec: 200, location: "x/y.mp3", ...extra });

describe("track mapping", () => {
  it("maps a server track to a Cadence track with the source prefix", () => {
    expect(toTrack(dto(), "webdav:", "webdav")).toEqual({
      id: "webdav:abc",
      title: "Song",
      artists: [{ id: "Artist", name: "Artist" }],
      album: "Album",
      durationSec: 200,
      source: "webdav",
    });
  });

  it("falls back to the album artist, then to Unknown artist", () => {
    expect(toTrack(dto({ artist: null, albumArtist: "Band" }), "s3:", "s3").artists[0]!.name).toBe("Band");
    const t = toTrack(dto({ artist: null, album: null, durationSec: null }), "s3:", "s3");
    expect(t.artists[0]!.name).toBe("Unknown artist");
    expect(t.album).toBeUndefined();
    expect(t.durationSec).toBeUndefined();
  });

  it("recognises only its own prefix", () => {
    expect(remoteId({ id: "webdav:abc" }, "webdav:")).toBe("abc");
    expect(remoteId({ id: "server:abc" }, "webdav:")).toBeNull();
    expect(remoteId({ id: "webdav:" }, "webdav:")).toBeNull();
  });
});

describe("messages", () => {
  it("strips the request prefix the server store adds", () => {
    expect(plainError(new Error("Request failed (400): The server refused that user name or password"))).toBe("The server refused that user name or password");
    expect(plainError(new Error("Request failed (502)"))).toBe("The server couldn't do that");
    expect(plainError("plain")).toBe("plain");
  });

  it("says how long ago in plain words", () => {
    const now = 1_000_000_000_000;
    expect(timeAgo(now - 10_000, now)).toBe("just now");
    expect(timeAgo(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(timeAgo(now - 4 * 86_400_000, now)).toBe("4 days ago");
    expect(timeAgo(now + 5000, now)).toBe("just now");
  });
});

describe("indexer summary", () => {
  const base: IndexingDto = { ...NEVER_INDEXED };
  const now = 1_000_000_000_000;

  it("describes each state", () => {
    expect(summarizeIndexing(0, base, now)).toEqual({ text: "Not indexed yet", busy: false, problem: null });
    expect(summarizeIndexing(5, { ...base, running: true, status: "running", found: 40 }, now)).toMatchObject({ busy: true, text: "Indexing… found 40 files, 5 tracks ready" });
    expect(summarizeIndexing(0, { ...base, running: true, status: "running" }, now).text).toBe("Looking through your files…");
    expect(summarizeIndexing(1, { ...base, status: "done", finishedAt: now - 120_000 }, now).text).toBe("1 track, updated 2 min ago");
    expect(summarizeIndexing(3, { ...base, status: "interrupted" }, now).text).toMatch(/interrupted/);
  });

  it("turns failures into something a person can act on", () => {
    const failed = (error: string) => summarizeIndexing(10, { ...base, status: "failed", error, finishedAt: now }, now);
    expect(failed("needs_reconnect").problem).toMatch(/Connect again/);
    expect(failed("auth_failed").problem).toMatch(/refused/);
    expect(failed("never-heard-of-it").problem).toMatch(/Indexing failed/);
    expect(failed("timeout").text).toBe("10 tracks, updated just now");
  });
});

describe("folder choices", () => {
  it("adds and removes a folder", () => {
    const a = { key: "/Music", name: "Music" };
    const b = { key: "/Other", name: "Other" };
    expect(toggleChoice([], a)).toEqual([a]);
    expect(toggleChoice([a], b)).toEqual([a, b]);
    expect(toggleChoice([a, b], a)).toEqual([b]);
  });

  it("builds crumbs for paths and prefixes", () => {
    expect(crumbs("/Music/Rock", "Share", "path")).toEqual([
      { key: "/", name: "Share" },
      { key: "/Music", name: "Music" },
      { key: "/Music/Rock", name: "Rock" },
    ]);
    expect(crumbs("/", "Share", "path")).toEqual([{ key: "/", name: "Share" }]);
    expect(crumbs("Music/Rock/", "Bucket", "prefix")).toEqual([
      { key: "", name: "Bucket" },
      { key: "Music/", name: "Music" },
      { key: "Music/Rock/", name: "Rock" },
    ]);
  });
});

describe("stream link cache", () => {
  it("reuses a link until shortly before it expires", () => {
    let now = 1_000_000;
    const cache = new StreamLinkCache(60, () => now);
    cache.set("a", "https://x/a", 1_000 + 600); // expires 600 s after epoch second 1000
    expect(cache.get("a")).toBe("https://x/a");
    now = (1_600 - 61) * 1000;
    expect(cache.get("a")).toBe("https://x/a");
    now = (1_600 - 59) * 1000;
    expect(cache.get("a")).toBeNull();
    expect(cache.get("missing")).toBeNull();
    cache.set("b", "u", 99_999_999_999);
    cache.clear();
    expect(cache.get("b")).toBeNull();
  });
});
