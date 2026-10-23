import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, useServer } from "../../builtins/server/serverStore";
import { plexTrackId, toTrack, usePlex } from "./plexStore";

const BASE = "https://cadence.example";
const pt = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Song ${id}`, artists: ["Artist"], ...extra });
const linked = { configured: true, connected: true, userName: "ann", serverName: "Home", library: { key: "1", title: "Music" } };
const open = { code: "AB12", linkUrl: "https://plex.tv/link", expiresAt: 1 };

let api: ReturnType<typeof vi.fn>;

beforeEach(() => {
  api = vi.fn();
  useServer.setState({ url: BASE, token: "tok", api: api as never });
  usePlex.getState().reset();
});

describe("track mapping", () => {
  it("maps a Plex track to a Cadence track with a plex: id", () => {
    const t = toTrack(pt("101", { album: "Discovery", durationSec: 200, artwork: "api/plex/image/21?u=1&exp=2&sig=x" }), BASE);
    expect(t).toMatchObject({ id: "plex:101", title: "Song 101", album: "Discovery", artwork: `${BASE}/api/plex/image/21?u=1&exp=2&sig=x`, source: "plex" });
    expect(plexTrackId(t)).toBe("101");
    expect(plexTrackId({ id: "subsonic:101" })).toBeNull();
  });
});

describe("linking", () => {
  it("asks for a code and shows it", async () => {
    api.mockResolvedValue({ code: "AB12", linkUrl: "https://plex.tv/link", expiresAt: Date.now() + 1000 });
    await usePlex.getState().startLink();
    expect(api).toHaveBeenCalledWith("api/plex/pin", { method: "POST" });
    expect(usePlex.getState()).toMatchObject({ link: { code: "AB12" }, linkState: "waiting", error: null });
  });

  it("keeps waiting until the code is entered, then connects and loads the library", async () => {
    usePlex.setState({ link: open, linkState: "waiting" });
    api.mockResolvedValueOnce({ state: "waiting", expiresAt: 1 });
    await usePlex.getState().pollLink();
    expect(usePlex.getState()).toMatchObject({ linkState: "waiting", status: null });

    api.mockImplementation(async (route: string) => (route === "api/plex/pin" ? { state: "connected", status: linked } : { items: [pt("1")], total: 1, hasMore: false }));
    await usePlex.getState().pollLink();
    expect(usePlex.getState()).toMatchObject({ link: null, linkState: "idle", status: linked });
    await vi.waitFor(() => expect(usePlex.getState().tracks).toHaveLength(1));
  });

  it("loads the choice of libraries when the account has several", async () => {
    usePlex.setState({ link: open, linkState: "waiting" });
    api.mockImplementation(async (route: string) =>
      route === "api/plex/pin"
        ? { state: "connected", status: { configured: true, connected: true, userName: "ann", needsLibrary: true } }
        : { items: [{ key: "1", title: "Music" }, { key: "3", title: "Live" }], selected: null },
    );
    await usePlex.getState().pollLink();
    await vi.waitFor(() => expect(usePlex.getState().libraries).toHaveLength(2));
  });

  it("chooses a library", async () => {
    usePlex.setState({ status: { configured: true, connected: true, needsLibrary: true } });
    api.mockImplementation(async (route: string) => (route === "api/plex/library" ? linked : { items: [], total: 0, hasMore: false }));
    await usePlex.getState().chooseLibrary("1");
    expect(api).toHaveBeenCalledWith("api/plex/library", { method: "PUT", body: JSON.stringify({ key: "1" }) });
    expect(usePlex.getState().status?.library).toEqual({ key: "1", title: "Music" });
  });

  it.each([
    [{ state: "expired" }, "expired"],
    [{ state: "no_access" }, "no_access"],
  ])("ends the link on %j", async (answer, state) => {
    usePlex.setState({ link: open, linkState: "waiting" });
    api.mockResolvedValue(answer);
    await usePlex.getState().pollLink();
    expect(usePlex.getState()).toMatchObject({ link: null, linkState: state });
  });

  it("treats a missing code on the server as expired, but rides out plex.tv hiccups", async () => {
    usePlex.setState({ link: open, linkState: "waiting" });
    api.mockRejectedValueOnce(new ApiError("bad gateway", 502));
    await usePlex.getState().pollLink();
    expect(usePlex.getState()).toMatchObject({ linkState: "waiting", error: null });
    api.mockRejectedValueOnce(new ApiError("gone", 404));
    await usePlex.getState().pollLink();
    expect(usePlex.getState()).toMatchObject({ link: null, linkState: "expired" });
  });

  it("does not poll when no link is open, and cancel clears it", async () => {
    await usePlex.getState().pollLink();
    expect(api).not.toHaveBeenCalled();
    usePlex.setState({ link: open, linkState: "waiting" });
    usePlex.getState().cancelLink();
    expect(usePlex.getState()).toMatchObject({ link: null, linkState: "idle" });
  });

  it("explains a rate limit or an unreachable plex.tv when asking for a code", async () => {
    api.mockRejectedValueOnce(new ApiError("x", 429));
    await usePlex.getState().startLink();
    expect(usePlex.getState().error).toBe("Too many attempts. Try again in a few minutes.");
    api.mockRejectedValueOnce(new ApiError("x", 502));
    await usePlex.getState().startLink();
    expect(usePlex.getState().error).toMatch(/plex\.tv/);
  });
});

describe("status", () => {
  it("handles an expired Plex token (409) without touching the Cadence session", async () => {
    usePlex.setState({ status: linked });
    api.mockRejectedValue(new ApiError("expired", 409, "plex_session_expired"));
    await expect(usePlex.getState().listTracks()).rejects.toBeInstanceOf(ApiError);
    expect(usePlex.getState().status).toMatchObject({ connected: false });
    expect(usePlex.getState().error).toMatch(/Link your account again/);
    expect(useServer.getState().token).toBe("tok");
  });

  it("notices a missing library choice", async () => {
    usePlex.setState({ status: linked });
    api.mockRejectedValue(new ApiError("choose", 409, "plex_no_library"));
    await expect(usePlex.getState().listAlbums()).rejects.toBeInstanceOf(ApiError);
    expect(usePlex.getState().status).toMatchObject({ connected: true, needsLibrary: true });
    expect(usePlex.getState().status?.library).toBeUndefined();
  });

  it("does not load the library until one is chosen", async () => {
    api.mockResolvedValue({ configured: true, connected: true, needsLibrary: true });
    await usePlex.getState().refresh();
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("forgets everything on sign-out of Cadence", () => {
    usePlex.setState({ status: linked, tracks: [{ id: "plex:1", title: "x", artists: [] }], favourites: { "1": true } });
    usePlex.getState().reset();
    expect(usePlex.getState()).toMatchObject({ status: null, tracks: [], favourites: {}, link: null });
  });
});

describe("browsing, favourites and streaming", () => {
  it("builds paths and maps cards", async () => {
    api.mockResolvedValue({ items: [{ id: "21", name: "Discovery", artist: "Daft Punk", year: 2001 }], total: 1, hasMore: false });
    const albums = await usePlex.getState().listAlbums({ artistId: "11", sort: "newest" });
    expect(api).toHaveBeenCalledWith("api/plex/albums?artistId=11&sort=newest", undefined);
    expect(albums.items[0]).toEqual({ id: "21", name: "Discovery", subtitle: "Daft Punk · 2001", artwork: undefined });
  });

  it("toggles a favourite with rollback", async () => {
    const track = toTrack(pt("101"), BASE);
    api.mockResolvedValueOnce(undefined);
    await usePlex.getState().toggleFavourite(track);
    expect(api).toHaveBeenLastCalledWith("api/plex/favourites/101", { method: "PUT" });
    expect(usePlex.getState().favourites["101"]).toBe(true);
    api.mockRejectedValueOnce(new Error("nope"));
    await usePlex.getState().toggleFavourite(track);
    expect(usePlex.getState().favourites["101"]).toBe(true);
  });

  it("returns signed stream URLs and reports plays", async () => {
    api.mockResolvedValue({ path: "api/plex/stream/101?u=1&exp=9&sig=z", expiresAt: Date.now() / 1000 + 3600, mode: "direct" });
    expect(await usePlex.getState().streamUrl("101")).toBe(`${BASE}/api/plex/stream/101?u=1&exp=9&sig=z`);
    api.mockResolvedValue(undefined);
    await usePlex.getState().report("stop", "101", 150, 200);
    expect(api).toHaveBeenLastCalledWith("api/plex/playback", { method: "POST", body: JSON.stringify({ event: "stop", itemId: "101", positionSec: 150, durationSec: 200 }) });
  });
});