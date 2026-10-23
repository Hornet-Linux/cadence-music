import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, useServer } from "@/plugins/builtins/server/serverStore";
import { POLL_MS, createStreamingStore, describe as describeError, serviceId, toTrack, type StreamingStore } from "./store";
import type { ServiceInfo, StreamStatus, StreamTrack } from "./types";

const info: ServiceInfo = {
  slug: "demo",
  name: "Demo",
  prefix: "demo:",
  homepage: "https://demo.example/",
  credit: { text: "Powered by Demo", href: "https://demo.example/" },
  termsHref: "https://demo.example/terms",
  adminHelp: "",
  capabilities: { works: [], limits: [] },
};

const status = (over: Partial<StreamStatus> = {}): StreamStatus => ({
  service: "demo",
  name: "Demo",
  configured: true,
  connected: false,
  hasLogin: true,
  features: { search: true, library: true, playlists: true, playback: "preview" },
  ...over,
});

const st = (id: string, over: Partial<StreamTrack> = {}): StreamTrack => ({
  id,
  title: `Song ${id}`,
  artists: ["Artist"],
  playback: "preview",
  ...over,
});

let api: ReturnType<typeof vi.fn>;
let store: StreamingStore;
let open: ReturnType<typeof vi.fn>;

beforeEach(() => {
  api = vi.fn();
  store = createStreamingStore(info);
  useServer.setState({ url: "https://cadence.example", token: "tok", api: api as never });
  open = vi.fn();
  vi.stubGlobal("open", open);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("track mapping", () => {
  it("makes prefixed Cadence ids and keeps the service's id recoverable", () => {
    const t = toTrack(info, st("42", { artists: ["A", "B"], album: "LP", artwork: "https://x/y.jpg", durationSec: 90 }));
    expect(t).toEqual({
      id: "demo:42",
      title: "Song 42",
      artists: [
        { id: "A", name: "A" },
        { id: "B", name: "B" },
      ],
      album: "LP",
      artwork: "https://x/y.jpg",
      durationSec: 90,
      source: "demo",
    });
    expect(serviceId(info, t)).toBe("42");
    expect(serviceId(info, { id: "other:42" })).toBeNull();
  });

  it("copes with no artist", () => {
    expect(toTrack(info, st("1", { artists: [] })).artists[0]!.name).toBe("Unknown artist");
  });
});

describe("status", () => {
  it("loads the status, and the saved tracks when connected", async () => {
    api.mockImplementation(async (route: string) => (route.endsWith("/status") ? status({ connected: true }) : { items: [st("1", { url: "https://demo.example/t/1", note: "Preview only" })] }));
    await store.getState().refresh();
    await vi.waitFor(() => expect(store.getState().library).toHaveLength(1));
    expect(api).toHaveBeenCalledWith("api/streaming/demo/status", undefined);
    expect(store.getState().links["demo:1"]).toBe("https://demo.example/t/1");
    expect(store.getState().notes["demo:1"]).toBe("Preview only");
    expect(store.getState().playback["demo:1"]).toBe("preview");
  });

  it("does nothing for an unconfigured service", async () => {
    api.mockResolvedValue(status({ configured: false }));
    await store.getState().refresh();
    expect(api).toHaveBeenCalledTimes(1);
    expect(store.getState().status?.configured).toBe(false);
  });

  it("treats a 404 as the add-on not being turned on, without an error", async () => {
    api.mockRejectedValue(new ApiError("Request failed (404)", 404));
    await store.getState().refresh();
    expect(store.getState().missing).toBe(true);
    expect(store.getState().error).toBeNull();
  });

  it("resets when signed out of Cadence", async () => {
    useServer.setState({ token: null });
    store.setState({ library: [toTrack(info, st("1"))] });
    await store.getState().refresh();
    expect(store.getState().library).toEqual([]);
    expect(api).not.toHaveBeenCalled();
  });
});

describe("search and library", () => {
  it("encodes the query and remembers links and playback kinds", async () => {
    api.mockResolvedValue({ items: [st("7", { url: "https://demo.example/t/7", playback: "link" })] });
    const tracks = await store.getState().search("a&b c");
    expect(api).toHaveBeenCalledWith("api/streaming/demo/search?q=a%26b%20c", undefined);
    expect(tracks.map((t) => t.id)).toEqual(["demo:7"]);
    expect(store.getState().playback["demo:7"]).toBe("link");
  });

  it("a service-session-expired answer while loading the library disconnects in the UI", async () => {
    store.setState({ status: status({ connected: true }) });
    api.mockRejectedValue(new ApiError("Request failed (409)", 409, "demo_session_expired"));
    await store.getState().loadLibrary();
    expect(store.getState().status?.connected).toBe(false);
    expect(store.getState().error).toMatch(/sign-in expired/);
  });

  it("loads playlists and their tracks", async () => {
    api.mockResolvedValueOnce({ items: [{ id: "p1", name: "Mix" }] }).mockResolvedValueOnce({ items: [st("9")] });
    expect(await store.getState().playlists()).toEqual([{ id: "p1", name: "Mix" }]);
    const tracks = await store.getState().playlistTracks("p1");
    expect(api).toHaveBeenLastCalledWith("api/streaming/demo/playlists/p1/tracks", undefined);
    expect(tracks[0]!.id).toBe("demo:9");
  });
});

describe("connecting an account", () => {
  it("opens the sign-in page, polls until the server says connected, then loads the library", async () => {
    vi.useFakeTimers();
    let connected = false;
    api.mockImplementation(async (route: string, init?: RequestInit) => {
      if (route.endsWith("/connect/start")) {
        expect(init?.method).toBe("POST");
        return { url: "https://auth.demo.example/authorize?state=s" };
      }
      if (route.endsWith("/status")) return status({ connected });
      return { items: [st("1")] };
    });
    store.setState({ status: status() });
    await store.getState().connect();
    expect(open).toHaveBeenCalledWith("https://auth.demo.example/authorize?state=s", "_blank", "noopener");
    expect(store.getState().waiting).toBe(true);
    expect(store.getState().signInUrl).toContain("auth.demo.example");

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(store.getState().waiting).toBe(true);

    connected = true;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(store.getState().waiting).toBe(false);
    expect(store.getState().status?.connected).toBe(true);
    await vi.waitFor(() => expect(store.getState().library).toHaveLength(1));
  });

  it("stops and shows the reason when the service refused the sign-in", async () => {
    vi.useFakeTimers();
    api.mockImplementation(async (route: string) =>
      route.endsWith("/connect/start") ? { url: "https://x/" } : status({ loginError: "Demo did not allow the connection." }),
    );
    store.setState({ status: status() });
    await store.getState().connect();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(store.getState().waiting).toBe(false);
    expect(store.getState().error).toBe("Demo did not allow the connection.");
  });

  it("gives up after a few minutes", async () => {
    vi.useFakeTimers();
    api.mockImplementation(async (route: string) => (route.endsWith("/connect/start") ? { url: "https://x/" } : status()));
    await store.getState().connect();
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 3 * POLL_MS);
    expect(store.getState().waiting).toBe(false);
    expect(store.getState().error).toMatch(/Timed out/);
  });

  it("cancel stops polling", async () => {
    vi.useFakeTimers();
    api.mockImplementation(async (route: string) => (route.endsWith("/connect/start") ? { url: "https://x/" } : status()));
    await store.getState().connect();
    store.getState().cancelConnect();
    api.mockClear();
    await vi.advanceTimersByTimeAsync(10 * POLL_MS);
    expect(api).not.toHaveBeenCalled();
    expect(store.getState().waiting).toBe(false);
  });

  it("a server that is not configured gives a plain message", async () => {
    api.mockRejectedValue(new ApiError("Request failed (409)", 409, "demo_not_configured"));
    await store.getState().connect();
    expect(store.getState().error).toBe("Demo isn't set up on this server yet.");
    expect(store.getState().waiting).toBe(false);
  });

  it("disconnect clears the library", async () => {
    api.mockResolvedValue(undefined);
    store.setState({ status: status({ connected: true }), library: [toTrack(info, st("1"))] });
    await store.getState().disconnect();
    expect(api).toHaveBeenCalledWith("api/streaming/demo/connection", { method: "DELETE" });
    expect(store.getState().status?.connected).toBe(false);
    expect(store.getState().library).toEqual([]);
  });
});

describe("owner credentials", () => {
  it("saves and reloads, never keeping a secret in the store", async () => {
    api.mockImplementation(async (route: string, init?: RequestInit) => {
      if (route.endsWith("/config") && init?.method === "PUT") return undefined;
      if (route.endsWith("/config")) return { configured: true, fields: [{ key: "secret", label: "Secret", secret: true, optional: false, set: true }] };
      return status();
    });
    const ok = await store.getState().saveAdminConfig({ clientId: "abc", secret: "shh" });
    expect(ok).toBe(true);
    expect(api).toHaveBeenCalledWith("api/streaming/demo/config", { method: "PUT", body: JSON.stringify({ clientId: "abc", secret: "shh" }) });
    expect(JSON.stringify(store.getState().adminConfig)).not.toContain("shh");
  });

  it("explains a refused value", async () => {
    api.mockRejectedValue(new ApiError("Request failed (400)", 400, "invalid_clientId"));
    expect(await store.getState().saveAdminConfig({ clientId: "bad value" })).toBe(false);
    expect(store.getState().error).toMatch(/invalid character/);
  });
});

describe("error text", () => {
  it("uses the server's fixed phrase for upstream failures", () => {
    expect(describeError(new ApiError("Request failed (502): Demo took too long to answer", 502, "demo_failed"), "Demo")).toBe("Demo took too long to answer");
    expect(describeError(new ApiError("Request failed (429)", 429), "Demo")).toMatch(/Too many/);
  });
});
