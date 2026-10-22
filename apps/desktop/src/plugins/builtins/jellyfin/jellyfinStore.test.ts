import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JellyfinTrack } from "@uma/shared";
import { ApiError, useServer } from "../server/serverStore";
import { jellyfinItemId, toTrack, useJellyfin } from "./jellyfinStore";

const BASE = "https://cadence.example";
const jt = (id: string, extra: Partial<JellyfinTrack> = {}): JellyfinTrack => ({
  id,
  title: `Song ${id}`,
  artists: ["Artist"],
  ...extra,
});

let api: ReturnType<typeof vi.fn>;

beforeEach(() => {
  api = vi.fn();
  useServer.setState({ url: BASE, token: "tok", api: api as never });
  useJellyfin.getState().reset();
});

describe("track mapping", () => {
  it("maps a Jellyfin track to a Cadence track with a jellyfin: id", () => {
    const t = toTrack(
      jt("abc", { artists: ["A", "B"], album: "Album", durationSec: 200, artwork: "api/jellyfin/items/abc/image?sig=1" }),
      BASE,
    );
    expect(t).toEqual({
      id: "jellyfin:abc",
      title: "Song abc",
      artists: [
        { id: "A", name: "A" },
        { id: "B", name: "B" },
      ],
      album: "Album",
      artwork: `${BASE}/api/jellyfin/items/abc/image?sig=1`,
      durationSec: 200,
      source: "jellyfin",
    });
    expect(jellyfinItemId(t)).toBe("abc");
    expect(jellyfinItemId({ id: "server:abc" })).toBeNull();
  });

  it("copes with no artwork and no artists", () => {
    const t = toTrack(jt("x", { artists: [] }), BASE);
    expect(t.artwork).toBeUndefined();
    expect(t.artists[0].name).toBe("Unknown artist");
  });
});

describe("status and sign-in", () => {
  it("loads the status and the first page of tracks when signed in", async () => {
    api.mockImplementation(async (route: string) =>
      route === "api/jellyfin/status"
        ? { configured: true, connected: true, userName: "ann", serverName: "Home" }
        : { items: [jt("1")], total: 1 },
    );
    await useJellyfin.getState().refresh();
    await vi.waitFor(() => expect(useJellyfin.getState().tracks).toHaveLength(1));
    expect(useJellyfin.getState().status).toMatchObject({ connected: true, userName: "ann" });
    expect(api).toHaveBeenCalledWith("api/jellyfin/tracks?limit=200", undefined);
  });

  it("reports an unconfigured server without loading anything", async () => {
    api.mockResolvedValue({ configured: false, connected: false });
    await useJellyfin.getState().refresh();
    expect(useJellyfin.getState().status).toEqual({ configured: false, connected: false });
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("treats a server without Jellyfin routes as not set up", async () => {
    api.mockRejectedValue(new ApiError("Request failed (404)", 404));
    await useJellyfin.getState().refresh();
    expect(useJellyfin.getState()).toMatchObject({ status: { configured: false, connected: false }, error: null });
  });

  it("connects with a username and password", async () => {
    api.mockImplementation(async (route: string) =>
      route === "api/jellyfin/connection" ? { configured: true, connected: true, userName: "ann" } : { items: [], total: 0 },
    );
    expect(await useJellyfin.getState().connect(" ann ", "pw")).toBe(true);
    const [, init] = api.mock.calls[0];
    expect(api.mock.calls[0][0]).toBe("api/jellyfin/connection");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ username: "ann", password: "pw" });
    expect(useJellyfin.getState().status?.connected).toBe(true);
  });

  it("explains wrong credentials and an unreachable Jellyfin", async () => {
    api.mockRejectedValueOnce(new ApiError("Request failed (401)", 401, "invalid_credentials"));
    expect(await useJellyfin.getState().connect("ann", "bad")).toBe(false);
    expect(useJellyfin.getState().error).toMatch(/wrong jellyfin username or password/i);
    api.mockRejectedValueOnce(new ApiError("Request failed (502)", 502));
    await useJellyfin.getState().connect("ann", "pw");
    expect(useJellyfin.getState().error).toMatch(/couldn't reach jellyfin/i);
    expect(useJellyfin.getState().busy).toBe(false);
  });

  it("disconnects and forgets the library", async () => {
    useJellyfin.setState({ status: { configured: true, connected: true }, tracks: [toTrack(jt("1"), BASE)], trackTotal: 1 });
    api.mockResolvedValue(undefined);
    await useJellyfin.getState().disconnect();
    expect(api).toHaveBeenCalledWith("api/jellyfin/connection", { method: "DELETE" });
    expect(useJellyfin.getState()).toMatchObject({ status: { configured: true, connected: false }, tracks: [], trackTotal: 0 });
  });

  it("goes back to signed out of Jellyfin (not Cadence) when the session expires", async () => {
    useJellyfin.setState({ status: { configured: true, connected: true } });
    api.mockRejectedValue(new ApiError("Request failed (401): jellyfin session expired", 401, "jellyfin_session_expired"));
    await expect(useJellyfin.getState().listTracks()).rejects.toBeInstanceOf(ApiError);
    expect(useJellyfin.getState().status).toMatchObject({ configured: true, connected: false });
    expect(useJellyfin.getState().error).toMatch(/session expired/i);
    expect(useServer.getState().token).toBe("tok");
  });
});

describe("browsing", () => {
  it("builds the query strings and maps results", async () => {
    api.mockResolvedValueOnce({ items: [jt("1", { artwork: "a/1" })], total: 5 });
    const page = await useJellyfin.getState().listTracks({ q: "mo on", favourites: true, limit: 10, offset: 20 });
    expect(api).toHaveBeenCalledWith("api/jellyfin/tracks?q=mo+on&favourites=1&limit=10&offset=20", undefined);
    expect(page.total).toBe(5);
    expect(page.items[0]).toMatchObject({ id: "jellyfin:1", artwork: `${BASE}/a/1` });

    api.mockResolvedValueOnce({ items: [{ id: "al", name: "Album", artist: "Art", year: 1999, artwork: "a/al" }], total: 1 });
    const albums = await useJellyfin.getState().listAlbums({ q: "x" });
    expect(albums.items[0]).toEqual({ id: "al", name: "Album", subtitle: "Art · 1999", artwork: `${BASE}/a/al` });

    api.mockResolvedValueOnce({ items: [{ id: "p", name: "Mix", trackCount: 1 }] });
    expect((await useJellyfin.getState().listPlaylists())[0]).toMatchObject({ id: "p", subtitle: "1 track" });

    api.mockResolvedValueOnce({ items: [jt("9")], total: 1 });
    await useJellyfin.getState().albumTracks("al/1");
    expect(api).toHaveBeenLastCalledWith("api/jellyfin/albums/al%2F1/tracks", undefined);
  });
});

describe("favourites", () => {
  const track = () => toTrack(jt("1"), BASE);

  it("updates at once and keeps the change when the server accepts it", async () => {
    let release!: () => void;
    api.mockReturnValue(new Promise<void>((r) => (release = r)));
    const done = useJellyfin.getState().toggleFavourite(track());
    expect(useJellyfin.getState().favourites["1"]).toBe(true);
    release();
    await done;
    expect(api).toHaveBeenCalledWith("api/jellyfin/favourites/1", { method: "PUT" });
    expect(useJellyfin.getState().favourites["1"]).toBe(true);
  });

  it("removes a favourite with DELETE", async () => {
    useJellyfin.setState({ favourites: { "1": true } });
    api.mockResolvedValue(undefined);
    await useJellyfin.getState().toggleFavourite(track());
    expect(api).toHaveBeenCalledWith("api/jellyfin/favourites/1", { method: "DELETE" });
    expect(useJellyfin.getState().favourites["1"]).toBe(false);
  });

  it("rolls back and shows the error when the server refuses", async () => {
    api.mockRejectedValue(new ApiError("Request failed (500)", 500));
    await useJellyfin.getState().toggleFavourite(track());
    expect(useJellyfin.getState().favourites["1"]).toBe(false);
    expect(useJellyfin.getState().error).toContain("500");
  });

  it("learns hearts from the lists it loads", async () => {
    api.mockResolvedValueOnce({ items: [jt("1", { favourite: true }), jt("2")], total: 2 });
    await useJellyfin.getState().listTracks();
    expect(useJellyfin.getState().favourites).toEqual({ "1": true, "2": false });
  });

  it("ignores tracks from other sources", async () => {
    await useJellyfin.getState().toggleFavourite({ id: "server:1", title: "x", artists: [] });
    expect(api).not.toHaveBeenCalled();
  });
});

describe("stream URLs", () => {
  const now = () => Date.now() / 1000;

  it("builds an absolute URL from the signed path", async () => {
    api.mockResolvedValue({ path: "api/jellyfin/stream/1?sig=a", expiresAt: now() + 3600 });
    expect(await useJellyfin.getState().streamUrl("1")).toBe(`${BASE}/api/jellyfin/stream/1?sig=a`);
    expect(api).toHaveBeenCalledWith("api/jellyfin/tracks/1/stream-url", undefined);
  });

  it("reuses a URL until it is about to expire, then asks again", async () => {
    api.mockResolvedValueOnce({ path: "s/1?sig=a", expiresAt: now() + 3600 });
    const first = await useJellyfin.getState().streamUrl("1");
    expect(await useJellyfin.getState().streamUrl("1")).toBe(first);
    expect(api).toHaveBeenCalledTimes(1);

    useJellyfin.getState().reset();
    api.mockResolvedValueOnce({ path: "s/2?sig=old", expiresAt: now() + 10 });
    await useJellyfin.getState().streamUrl("2");
    api.mockResolvedValueOnce({ path: "s/2?sig=new", expiresAt: now() + 3600 });
    expect(await useJellyfin.getState().streamUrl("2")).toBe(`${BASE}/s/2?sig=new`);
    expect(api).toHaveBeenCalledTimes(3);
  });
});

describe("DJ helpers", () => {
  it("keeps match results in order with nulls for misses", async () => {
    api.mockResolvedValue({ matches: [jt("1"), null, jt("3")] });
    const out = await useJellyfin.getState().match([
      { artist: "A", title: "One" },
      { artist: "B", title: "Two" },
      { artist: "C", title: "Three" },
    ]);
    expect(out.map((t) => t?.id ?? null)).toEqual(["jellyfin:1", null, "jellyfin:3"]);
    expect(JSON.parse(api.mock.calls[0][1].body).picks).toHaveLength(3);
  });

  it("fetches the taste profile", async () => {
    const profile = { topArtists: ["A"], genres: [], topTracks: [], recentTracks: [] };
    api.mockResolvedValue(profile);
    expect(await useJellyfin.getState().taste()).toEqual(profile);
    expect(api).toHaveBeenCalledWith("api/jellyfin/taste", undefined);
  });
});

describe("playback report", () => {
  it("posts the event and never throws", async () => {
    api.mockResolvedValueOnce(undefined);
    await useJellyfin.getState().report("start", "1", 0);
    const [route, init] = api.mock.calls[0];
    expect(route).toBe("api/jellyfin/playback");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ event: "start", itemId: "1", positionSec: 0 });

    api.mockRejectedValueOnce(new Error("offline"));
    await expect(useJellyfin.getState().report("stop", "1", 12.34)).resolves.toBeUndefined();
  });
});
