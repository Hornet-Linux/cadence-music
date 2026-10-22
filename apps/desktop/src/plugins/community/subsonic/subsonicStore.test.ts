import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, useServer } from "../../builtins/server/serverStore";
import { subsonicTrackId, toTrack, useSubsonic } from "./subsonicStore";

const BASE = "https://cadence.example";
const st = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Song ${id}`, artists: ["Artist"], ...extra });

let api: ReturnType<typeof vi.fn>;

beforeEach(() => {
  api = vi.fn();
  useServer.setState({ url: BASE, token: "tok", api: api as never });
  useSubsonic.getState().reset();
});

describe("track mapping", () => {
  it("maps a Subsonic track to a Cadence track with a subsonic: id and an absolute cover URL", () => {
    const t = toTrack(st("s1", { artists: ["A", "B"], album: "Album", durationSec: 200, artwork: "api/subsonic/image/al1?u=1&exp=2&sig=x" }), BASE);
    expect(t).toEqual({
      id: "subsonic:s1",
      title: "Song s1",
      artists: [
        { id: "A", name: "A" },
        { id: "B", name: "B" },
      ],
      album: "Album",
      artwork: `${BASE}/api/subsonic/image/al1?u=1&exp=2&sig=x`,
      durationSec: 200,
      source: "subsonic",
    });
    expect(subsonicTrackId(t)).toBe("s1");
    expect(subsonicTrackId({ id: "plex:1" })).toBeNull();
    expect(subsonicTrackId({ id: "server:s1" })).toBeNull();
  });

  it("copes with no artwork and no artists", () => {
    const t = toTrack(st("x", { artists: [] }), BASE);
    expect(t.artwork).toBeUndefined();
    expect(t.artists[0].name).toBe("Unknown artist");
  });
});

describe("status and sign-in", () => {
  it("loads the status and the first page of tracks when signed in", async () => {
    api.mockImplementation(async (route: string) =>
      route === "api/subsonic/status" ? { configured: true, connected: true, userName: "ann", serverName: "Navidrome" } : { items: [st("1")], total: 1, hasMore: false },
    );
    await useSubsonic.getState().refresh();
    await vi.waitFor(() => expect(useSubsonic.getState().tracks).toHaveLength(1));
    expect(useSubsonic.getState().status).toMatchObject({ connected: true, userName: "ann" });
    expect(api).toHaveBeenCalledWith("api/subsonic/tracks?limit=200", undefined);
  });

  it("reports an unconfigured server without loading anything", async () => {
    api.mockResolvedValue({ configured: false, connected: false });
    await useSubsonic.getState().refresh();
    expect(useSubsonic.getState().status).toEqual({ configured: false, connected: false });
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("treats a server without the Subsonic routes as not set up", async () => {
    api.mockRejectedValue(new ApiError("Request failed (404)", 404));
    await useSubsonic.getState().refresh();
    expect(useSubsonic.getState()).toMatchObject({ status: { configured: false, connected: false }, error: null });
  });

  it("does nothing without a Cadence sign-in", async () => {
    useServer.setState({ token: null });
    await useSubsonic.getState().refresh();
    expect(api).not.toHaveBeenCalled();
    expect(useSubsonic.getState().status).toBeNull();
  });

  it("signs in with a username and password and then loads the library", async () => {
    api.mockImplementation(async (route: string) =>
      route === "api/subsonic/connection" ? { configured: true, connected: true, userName: "ann" } : { items: [], total: 0, hasMore: false },
    );
    expect(await useSubsonic.getState().connect("  ann ", "pw")).toBe(true);
    expect(api).toHaveBeenCalledWith("api/subsonic/connection", { method: "PUT", body: JSON.stringify({ username: "ann", password: "pw" }) });
    expect(useSubsonic.getState().status?.connected).toBe(true);
  });

  it.each([
    [422, "Wrong Subsonic username or password."],
    [429, "Too many attempts. Try again in a few minutes."],
    [502, "The server couldn't reach Subsonic. Try again in a moment."],
  ])("explains a %i answer to sign-in", async (status, text) => {
    api.mockRejectedValue(new ApiError("x", status));
    expect(await useSubsonic.getState().connect("ann", "pw")).toBe(false);
    expect(useSubsonic.getState().error).toBe(text);
    expect(useSubsonic.getState().status).toBeNull();
  });

  it("goes back to signed out, without touching the Cadence session, when Subsonic's sign-in stops working", async () => {
    useSubsonic.setState({ status: { configured: true, connected: true, userName: "ann" } });
    api.mockRejectedValue(new ApiError("expired", 409, "subsonic_session_expired"));
    await expect(useSubsonic.getState().listTracks()).rejects.toBeInstanceOf(ApiError);
    expect(useSubsonic.getState().status).toEqual({ configured: true, connected: false, userName: "ann" });
    expect(useSubsonic.getState().error).toMatch(/Sign in again/);
    expect(useServer.getState().token).toBe("tok");
  });

  it("signs out and forgets the library", async () => {
    useSubsonic.setState({ status: { configured: true, connected: true }, tracks: [{ id: "subsonic:1", title: "x", artists: [] }] });
    api.mockResolvedValue(undefined);
    await useSubsonic.getState().disconnect();
    expect(api).toHaveBeenCalledWith("api/subsonic/connection", { method: "DELETE" });
    expect(useSubsonic.getState()).toMatchObject({ status: { configured: true, connected: false }, tracks: [] });
  });

  it("keeps the person signed in if signing out fails", async () => {
    useSubsonic.setState({ status: { configured: true, connected: true } });
    api.mockRejectedValue(new Error("offline"));
    await useSubsonic.getState().disconnect();
    expect(useSubsonic.getState().status?.connected).toBe(true);
    expect(useSubsonic.getState().error).toBe("offline");
  });
});

describe("browsing", () => {
  it("passes the query to the server and maps albums, artists and playlists to cards with absolute covers", async () => {
    api.mockImplementation(async (route: string) => {
      if (route.startsWith("api/subsonic/albums?")) return { items: [{ id: "al1", name: "Discovery", artist: "Daft Punk", year: 2001, artwork: "api/subsonic/image/al1?x=1" }], total: 1, hasMore: true };
      if (route.startsWith("api/subsonic/artists")) return { items: [{ id: "ar1", name: "Daft Punk", albumCount: 1 }], total: 1, hasMore: false };
      return { items: [{ id: "p1", name: "Night drive", trackCount: 1 }] };
    });
    const albums = await useSubsonic.getState().listAlbums({ q: "dis", limit: 10, offset: 20, sort: "newest" });
    expect(api).toHaveBeenCalledWith("api/subsonic/albums?q=dis&limit=10&offset=20&sort=newest", undefined);
    expect(albums).toEqual({ items: [{ id: "al1", name: "Discovery", subtitle: "Daft Punk · 2001", artwork: `${BASE}/api/subsonic/image/al1?x=1` }], total: 1, hasMore: true });
    expect((await useSubsonic.getState().listArtists()).items[0]).toEqual({ id: "ar1", name: "Daft Punk", subtitle: "1 album", artwork: undefined });
    expect(await useSubsonic.getState().listPlaylists()).toEqual([{ id: "p1", name: "Night drive", subtitle: "1 track" }]);
  });

  it("encodes ids in paths", async () => {
    api.mockResolvedValue({ items: [], total: 0, hasMore: false });
    await useSubsonic.getState().albumTracks("a/b c");
    expect(api).toHaveBeenCalledWith("api/subsonic/albums/a%2Fb%20c/tracks", undefined);
  });
});

describe("favourites", () => {
  const track = toTrack(st("s1"), BASE);

  it("remembers flags from lists, toggles at once, and rolls back when the server refuses", async () => {
    api.mockResolvedValueOnce({ items: [st("s1", { favourite: true })], total: 1, hasMore: false });
    await useSubsonic.getState().listTracks();
    expect(useSubsonic.getState().favourites.s1).toBe(true);

    api.mockResolvedValueOnce(undefined);
    await useSubsonic.getState().toggleFavourite(track);
    expect(api).toHaveBeenLastCalledWith("api/subsonic/favourites/s1", { method: "DELETE" });
    expect(useSubsonic.getState().favourites.s1).toBe(false);

    api.mockRejectedValueOnce(new Error("nope"));
    await useSubsonic.getState().toggleFavourite(track);
    expect(api).toHaveBeenLastCalledWith("api/subsonic/favourites/s1", { method: "PUT" });
    expect(useSubsonic.getState().favourites.s1).toBe(false);
    expect(useSubsonic.getState().error).toBe("nope");
  });

  it("ignores tracks from other sources", async () => {
    await useSubsonic.getState().toggleFavourite({ id: "plex:1", title: "x", artists: [] });
    expect(api).not.toHaveBeenCalled();
  });
});

describe("streaming and reporting", () => {
  it("returns an absolute signed URL and reuses it until shortly before it expires", async () => {
    const exp = Date.now() / 1000 + 3600;
    api.mockResolvedValue({ path: "api/subsonic/stream/s1?u=1&exp=9&sig=z", expiresAt: exp });
    const url = await useSubsonic.getState().streamUrl("s1");
    expect(url).toBe(`${BASE}/api/subsonic/stream/s1?u=1&exp=9&sig=z`);
    await useSubsonic.getState().streamUrl("s1");
    expect(api).toHaveBeenCalledTimes(1);
    api.mockResolvedValue({ path: "api/subsonic/stream/s2?u=1&exp=9&sig=z", expiresAt: Date.now() / 1000 + 10 });
    await useSubsonic.getState().streamUrl("s2");
    await useSubsonic.getState().streamUrl("s2");
    expect(api).toHaveBeenCalledTimes(3);
  });

  it("sends playback reports, rounded, and swallows failures", async () => {
    api.mockResolvedValue(undefined);
    await useSubsonic.getState().report("stop", "s1", 12.3456, 200.04);
    expect(api).toHaveBeenCalledWith("api/subsonic/playback", { method: "POST", body: JSON.stringify({ event: "stop", itemId: "s1", positionSec: 12.3, durationSec: 200 }) });
    api.mockRejectedValue(new Error("down"));
    await expect(useSubsonic.getState().report("start", "s1", 0, 0)).resolves.toBeUndefined();
    expect(api).toHaveBeenLastCalledWith("api/subsonic/playback", { method: "POST", body: JSON.stringify({ event: "start", itemId: "s1", positionSec: 0 }) });
  });
});