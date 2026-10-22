import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ serverApi: vi.fn() }));
vi.mock("../_sourcekit/api", () => ({
  serverApi: h.serverApi,
  serverUrl: (p?: string) => (p ? `https://srv.example/${p}` : undefined),
  query: (o: Record<string, unknown>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") qs.set(k, String(v));
    return qs.size ? `?${qs}` : "";
  },
}));
vi.mock("../../builtins/server/serverStore", () => ({
  useServer: Object.assign(() => null, { getState: () => ({ token: "tok", user: { username: "a" }, url: "https://srv.example" }) }),
}));

import type { AudioSource, PluginContext } from "../../types";
import archivePlugin from "./index";
import { archiveTrackId, detailToTracks, fetchArchiveItem, fetchBands, fileOf, parseArchiveTrackId, searchArchive, streamAddress, yearOf, type ArchiveDetail } from "./archiveStore";

const detail: ArchiveDetail = {
  id: "gd77-05-08",
  title: "Barton Hall 1977-05-08",
  creator: "Grateful Dead",
  date: "1977-05-08",
  collections: ["etree"],
  cover: "api/archive/image/gd77-05-08?u=1&exp=2&sig=x",
  format: "mp3",
  formats: ["mp3", "ogg", "flac"],
  attribution: { text: "Barton Hall by Grateful Dead, from the Internet Archive, CC BY-NC-SA 3.0", detailsUrl: "https://archive.org/details/gd77-05-08", licence: { name: "CC BY-NC-SA 3.0", url: "https://creativecommons.org/licenses/by-nc-sa/3.0/" } },
  tracks: [
    { title: "New Minglewood Blues", track: 1, durationSec: 311, size: 5, format: "VBR MP3", path: "api/archive/stream/gd77-05-08?f=gd77-05-08d1t01.mp3&u=1&exp=2&sig=x" },
    { title: "Bonus", track: null, durationSec: 0, size: 1, format: "VBR MP3", path: "api/archive/stream/gd77-05-08?f=sub%2Fdir%2Fbonus.mp3&u=1&exp=2&sig=x" },
  ],
};

beforeEach(() => h.serverApi.mockReset());

describe("track ids", () => {
  it("round-trip, including file names with folders", () => {
    expect(archiveTrackId("gd77", "a b/c.mp3")).toBe("archive:gd77/a b/c.mp3");
    expect(parseArchiveTrackId("archive:gd77/a b/c.mp3")).toEqual({ identifier: "gd77", file: "a b/c.mp3" });
    expect(parseArchiveTrackId("archive:gd77/t01.mp3")).toEqual({ identifier: "gd77", file: "t01.mp3" });
  });
  it("refuses ids that are not ours or are incomplete", () => {
    for (const bad of ["radio:x/y", "archive:", "archive:noslash", "archive:/file", "archive:id/"]) expect(parseArchiveTrackId(bad)).toBeNull();
  });
  it("reads the file out of a signed path", () => {
    expect(fileOf(detail.tracks[1].path)).toBe("sub/dir/bonus.mp3");
    expect(fileOf("api/archive/stream/x")).toBeNull();
  });
});

describe("tracks from a recording", () => {
  it("carry creator, cover and the licence in the album line", () => {
    const tracks = detailToTracks(detail);
    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toMatchObject({ id: "archive:gd77-05-08/gd77-05-08d1t01.mp3", title: "New Minglewood Blues", album: "Barton Hall 1977-05-08 · CC BY-NC-SA 3.0", durationSec: 311, source: "archive" });
    expect(tracks[0].artists[0].name).toBe("Grateful Dead");
    expect(tracks[0].artwork).toBe("https://srv.example/api/archive/image/gd77-05-08?u=1&exp=2&sig=x");
    expect(tracks[1].id).toBe("archive:gd77-05-08/sub/dir/bonus.mp3");
    expect(tracks[1].durationSec).toBeUndefined();
  });
  it("without a licence the album is just the title, and without a creator it says where it is from", () => {
    const tracks = detailToTracks({ ...detail, creator: undefined, attribution: { ...detail.attribution, licence: undefined } });
    expect(tracks[0].album).toBe("Barton Hall 1977-05-08");
    expect(tracks[0].artists[0].name).toBe("Internet Archive");
  });
  it("years from either field", () => {
    expect(yearOf({ year: 1977 })).toBe("1977");
    expect(yearOf({ date: "1977-05-08" })).toBe("1977");
    expect(yearOf({})).toBe("");
  });
});

describe("server calls", () => {
  it("search builds a compact query", async () => {
    h.serverApi.mockResolvedValue({ items: [], total: 0, page: 1, hasMore: false });
    await searchArchive({ q: "dead", kind: "etree", collection: "GratefulDead", year: "1977", sort: "date", page: 2 });
    expect(h.serverApi).toHaveBeenCalledWith("api/archive/search?q=dead&kind=etree&collection=GratefulDead&year=1977&sort=date&page=2");
    await searchArchive({});
    expect(h.serverApi).toHaveBeenLastCalledWith("api/archive/search");
    await fetchBands("dead", 2);
    expect(h.serverApi).toHaveBeenLastCalledWith("api/archive/etree/bands?q=dead&page=2");
  });
  it("item and stream-address lookups encode their parts", async () => {
    h.serverApi.mockResolvedValue(detail);
    await fetchArchiveItem("gd77-05-08");
    expect(h.serverApi).toHaveBeenLastCalledWith("api/archive/items/gd77-05-08");
    await fetchArchiveItem("gd77-05-08", "ogg");
    expect(h.serverApi).toHaveBeenLastCalledWith("api/archive/items/gd77-05-08?format=ogg");
    h.serverApi.mockResolvedValue({ path: "api/archive/stream/x?f=a&u=1" });
    expect(await streamAddress("x", "a b.mp3")).toBe("https://srv.example/api/archive/stream/x?f=a&u=1");
    expect(h.serverApi).toHaveBeenLastCalledWith("api/archive/stream-url?id=x&f=a+b.mp3");
  });
});

describe("plugin", () => {
  it("is optional, asks for little, and only resolves its own tracks", async () => {
    expect(archivePlugin.manifest.builtin).toBeFalsy();
    expect(archivePlugin.manifest.capabilities).toEqual(["source.audio", "ui.sidebar", "network.outbound"]);
    let source!: AudioSource;
    const sidebar: string[] = [];
    const ctx = { registerSidebarItem: (i: { id: string }) => sidebar.push(i.id), registerAudioSource: (s: AudioSource) => (source = s) } as unknown as PluginContext;
    void archivePlugin.activate(ctx);
    expect(sidebar).toEqual(["internet-archive"]);
    expect(await source.resolve({ id: "radio:x", title: "", artists: [] })).toBeNull();
    h.serverApi.mockResolvedValue({ path: "api/archive/stream/gd77?f=t01.mp3&u=1" });
    expect(await source.resolve({ id: "archive:gd77/t01.mp3", title: "", artists: [] })).toBe("https://srv.example/api/archive/stream/gd77?f=t01.mp3&u=1");
  });
});