import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../builtins/server/serverStore";
import { NEVER_INDEXED, type RemoteStatus } from "./logic";
import { createRemoteSourceStore, type RemoteSourceDeps } from "./store";

const BASE = "https://cadence.example";
const track = (id: string, extra = {}) => ({ id, title: `Song ${id}`, artist: "A", album: "B", albumArtist: null, trackNo: null, durationSec: 100, location: null, ...extra });
const status = (extra: Partial<RemoteStatus> = {}): RemoteStatus => ({ connected: true, trackCount: 2, indexing: { ...NEVER_INDEXED, status: "done" }, ...extra });

let api: ReturnType<typeof vi.fn>;
let signedIn = true;
const deps = (): RemoteSourceDeps => ({ api: api as never, base: () => BASE, signedIn: () => signedIn });
const make = () => createRemoteSourceStore<RemoteStatus>({ area: "webdav", prefix: "webdav:", source: "webdav", label: "WebDAV" }, deps());

beforeEach(() => {
  api = vi.fn();
  signedIn = true;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("status", () => {
  it("loads the status and the first page of tracks when connected", async () => {
    api.mockImplementation(async (route: string) => (route === "api/webdav/status" ? status() : { items: [track("1"), track("2")], total: 2 }));
    const store = make();
    await store.getState().refresh();
    expect(store.getState().status?.connected).toBe(true);
    expect(store.getState().tracks.map((t) => t.id)).toEqual(["webdav:1", "webdav:2"]);
    expect(store.getState().trackTotal).toBe(2);
    expect(store.getState().unavailable).toBe(false);
  });

  it("treats a 404 as 'the plugin isn't turned on at the server'", async () => {
    api.mockRejectedValue(new ApiError("Request failed (404)", 404));
    const store = make();
    await store.getState().refresh();
    expect(store.getState()).toMatchObject({ unavailable: true, status: null, error: null });
  });

  it("shows other failures as a plain sentence", async () => {
    api.mockRejectedValue(new ApiError("Request failed (502): WebDAV couldn't be reached", 502));
    const store = make();
    await store.getState().refresh();
    expect(store.getState().error).toBe("WebDAV couldn't be reached");
    expect(store.getState().unavailable).toBe(false);
  });

  it("does nothing, and forgets everything, when signed out", async () => {
    const store = make();
    store.setState({ tracks: [{ id: "x", title: "x", artists: [] }], trackTotal: 1 });
    signedIn = false;
    await store.getState().refresh();
    expect(api).not.toHaveBeenCalled();
    expect(store.getState().tracks).toEqual([]);
  });

  it("clears the tracks when the server says it is not connected", async () => {
    api.mockResolvedValue(status({ connected: false, trackCount: 0 }));
    const store = make();
    store.setState({ tracks: [{ id: "x", title: "x", artists: [] }] });
    await store.getState().refresh();
    expect(store.getState().tracks).toEqual([]);
  });
});

describe("indexing progress", () => {
  it("keeps asking while the server is indexing and stops when it is done", async () => {
    vi.useFakeTimers();
    const running = status({ indexing: { ...NEVER_INDEXED, running: true, status: "running", found: 5 } });
    let calls = 0;
    api.mockImplementation(async (route: string) => {
      if (route === "api/webdav/status") return ++calls < 3 ? running : status();
      return { items: [track("1")], total: 1 };
    });
    const store = make();
    await store.getState().refresh();
    expect(store.getState().status?.indexing.running).toBe(true);
    await vi.advanceTimersByTimeAsync(2100);
    expect(store.getState().status?.indexing.running).toBe(true);
    await vi.advanceTimersByTimeAsync(2100);
    expect(store.getState().status?.indexing.running).toBe(false);
    const statusCalls = api.mock.calls.filter((c) => c[0] === "api/webdav/status").length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.mock.calls.filter((c) => c[0] === "api/webdav/status").length).toBe(statusCalls);
    expect(store.getState().tracks).toHaveLength(1);
  });

  it("stops polling on reset", async () => {
    vi.useFakeTimers();
    api.mockResolvedValue(status({ indexing: { ...NEVER_INDEXED, running: true, status: "running" } }));
    const store = make();
    await store.getState().refresh();
    store.getState().reset();
    const before = api.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.mock.calls.length).toBe(before);
  });
});

describe("connecting", () => {
  it("sends the form to the connection route and refreshes", async () => {
    api.mockImplementation(async (route: string) => (route === "api/webdav/status" ? status() : route === "api/webdav/connection" ? { connected: true } : { items: [], total: 0 }));
    const store = make();
    const ok = await store.getState().connect({ url: "https://x", username: "u", password: "p" });
    expect(ok).toBe(true);
    expect(api).toHaveBeenCalledWith("api/webdav/connection", { method: "PUT", body: JSON.stringify({ url: "https://x", username: "u", password: "p" }) });
    expect(store.getState().status?.connected).toBe(true);
    expect(store.getState().busy).toBe(false);
  });

  it("keeps the server's explanation when connecting fails", async () => {
    api.mockRejectedValue(new ApiError("Request failed (400): The server refused that user name or password", 400, "webdav_bad_credentials"));
    const store = make();
    expect(await store.getState().connect({})).toBe(false);
    expect(store.getState().error).toBe("The server refused that user name or password");
    expect(store.getState().busy).toBe(false);
  });

  it("disconnect clears the tracks", async () => {
    api.mockImplementation(async (route: string) => (route === "api/webdav/status" ? status({ connected: false, trackCount: 0 }) : undefined));
    const store = make();
    store.setState({ tracks: [{ id: "x", title: "x", artists: [] }], trackTotal: 1 });
    await store.getState().disconnect();
    expect(api).toHaveBeenCalledWith("api/webdav/connection", { method: "DELETE" });
    expect(store.getState().tracks).toEqual([]);
  });
});

describe("tracks and streaming", () => {
  it("builds the query for search and paging", async () => {
    api.mockResolvedValue({ items: [track("9")], total: 40 });
    const store = make();
    const page = await store.getState().listTracks({ q: "blue hour", album: "After Dark", limit: 50, offset: 100 });
    expect(api).toHaveBeenCalledWith("api/webdav/tracks?q=blue+hour&album=After+Dark&limit=50&offset=100", undefined);
    expect(page.total).toBe(40);
    expect(page.items[0]!.id).toBe("webdav:9");
  });

  it("asks for a signed link once and reuses it until it nearly expires", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 6 * 3600;
    api.mockResolvedValue({ path: "api/webdav/stream/abc?u=1&exp=1&sig=s", expiresAt });
    const store = make();
    const url = await store.getState().streamUrl("webdav:abc");
    expect(url).toBe(`${BASE}/api/webdav/stream/abc?u=1&exp=1&sig=s`);
    expect(api).toHaveBeenCalledWith("api/webdav/tracks/abc/stream-url", undefined);
    await store.getState().streamUrl("webdav:abc");
    expect(api).toHaveBeenCalledTimes(1);
    store.getState().reset();
    await store.getState().streamUrl("webdav:abc");
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("can read another source's status out of a combined answer", async () => {
    const store = createRemoteSourceStore<RemoteStatus>(
      {
        area: "onedrive-gdrive/google",
        statusRoute: "api/onedrive-gdrive/status",
        pickStatus: (raw) => (raw as { google: RemoteStatus }).google,
        prefix: "gdrive:",
        source: "gdrive",
        label: "Google Drive",
      },
      deps(),
    );
    api.mockImplementation(async (route: string) => (route === "api/onedrive-gdrive/status" ? { google: status({ trackCount: 7 }) } : { items: [], total: 0 }));
    await store.getState().refresh();
    expect(store.getState().status?.trackCount).toBe(7);
    expect(api).toHaveBeenCalledWith("api/onedrive-gdrive/status");
  });
});
