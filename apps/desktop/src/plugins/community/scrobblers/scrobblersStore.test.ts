import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, useServer } from "../../builtins/server/serverStore";
import type { ServiceStatus, StatusResponse } from "./logic";
import { useScrobblers } from "./scrobblersStore";

const svc = (
  id: ServiceStatus["id"],
  extra: Partial<ServiceStatus> = {},
): ServiceStatus => ({
  id,
  label: id,
  available: true,
  connected: false,
  enabled: false,
  needsReauth: false,
  awaitingApproval: false,
  sent: 0,
  queue: { pending: 0, sentToday: 0, dropped: 0, nextAttemptAt: null },
  ...extra,
});
const status = (extra: Partial<StatusResponse> = {}): StatusResponse => ({
  services: [svc("lastfm"), svc("listenbrainz")],
  customHostsAllowed: false,
  retryDays: 7,
  problems: [],
  isAdmin: false,
  ...extra,
});

let api: ReturnType<typeof vi.fn>;

beforeEach(() => {
  api = vi.fn();
  useServer.setState({
    url: "https://cadence.example",
    token: "tok",
    api: api as never,
  });
  useScrobblers.getState().reset();
});

describe("refresh", () => {
  it("loads the status from the server", async () => {
    api.mockResolvedValue(status());
    await useScrobblers.getState().refresh();
    expect(api).toHaveBeenCalledWith("api/scrobblers/status", undefined);
    expect(useScrobblers.getState().support).toBe("ok");
    expect(useScrobblers.getState().status?.services).toHaveLength(2);
  });

  it("treats a 404 as 'this server has no scrobbling'", async () => {
    api.mockRejectedValue(new ApiError("Request failed (404)", 404));
    await useScrobblers.getState().refresh();
    expect(useScrobblers.getState().support).toBe("missing");
    expect(useScrobblers.getState().error).toBeNull();
  });

  it("shows other failures as an error and keeps no stale support flag", async () => {
    api.mockRejectedValue(new Error("Request failed (500): boom"));
    await useScrobblers.getState().refresh();
    expect(useScrobblers.getState().error).toBe("boom");
    expect(useScrobblers.getState().support).toBe("unknown");
  });

  it("does nothing without a sign-in", async () => {
    useServer.setState({ token: null });
    await useScrobblers.getState().refresh();
    expect(api).not.toHaveBeenCalled();
    expect(useScrobblers.getState().status).toBeNull();
  });
});

describe("Last.fm approval", () => {
  it("fetches the approval link, then finishes", async () => {
    api.mockImplementation(async (route: string) => {
      if (route.endsWith("/connect"))
        return { approveUrl: "https://www.last.fm/api/auth/?token=t" };
      if (route.endsWith("/finish")) return { username: "rj" };
      return status();
    });
    await useScrobblers.getState().startApproval("lastfm");
    expect(useScrobblers.getState().approvals.lastfm).toBe(
      "https://www.last.fm/api/auth/?token=t",
    );
    expect(api).toHaveBeenCalledWith(
      "api/scrobblers/lastfm/connect",
      expect.objectContaining({ method: "POST" }),
    );

    expect(await useScrobblers.getState().finishApproval("lastfm")).toBe(true);
    expect(useScrobblers.getState().approvals.lastfm).toBeUndefined();
    expect(useScrobblers.getState().messages.lastfm).toEqual({
      kind: "ok",
      text: "Connected as rj.",
    });
  });

  it("keeps the link and shows the server's message when the person has not approved yet", async () => {
    api.mockImplementation(async (route: string) => {
      if (route.endsWith("/finish"))
        throw new ApiError(
          "Request failed (409): Last.fm hasn't been approved yet.",
          409,
          "not_approved",
        );
      return status();
    });
    useScrobblers.setState({
      approvals: { lastfm: "https://www.last.fm/api/auth/?token=t" },
    });
    expect(await useScrobblers.getState().finishApproval("lastfm")).toBe(false);
    expect(useScrobblers.getState().approvals.lastfm).toBeDefined();
    expect(useScrobblers.getState().messages.lastfm).toEqual({
      kind: "error",
      text: "Last.fm hasn't been approved yet.",
    });
    expect(useScrobblers.getState().busy.lastfm).toBeUndefined();
  });
});

describe("token services", () => {
  it("sends the ListenBrainz token (trimmed) and an optional host", async () => {
    api.mockResolvedValue({ username: "rj" });
    await useScrobblers.getState().connectListenBrainz("  tok-12345678 ", "");
    const [route, init] = api.mock.calls[0]!;
    expect(route).toBe("api/scrobblers/listenbrainz/connect");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      token: "tok-12345678",
    });

    await useScrobblers
      .getState()
      .connectListenBrainz("tok-12345678", " https://lb.home ");
    const second = api.mock.calls.find((c) =>
      (c[1] as RequestInit | undefined)?.body?.toString().includes("lb.home"),
    )!;
    expect(JSON.parse((second[1] as RequestInit).body as string).host).toBe(
      "https://lb.home",
    );
  });

  it("reports a refused Maloja key on its own card", async () => {
    api.mockImplementation(async (route: string) => {
      if (route.includes("maloja/connect"))
        throw new ApiError(
          "Request failed (403): The server owner has not allowed custom addresses.",
          403,
        );
      return status();
    });
    expect(
      await useScrobblers.getState().connectMaloja("https://m.example", "k"),
    ).toBe(false);
    expect(useScrobblers.getState().messages.maloja?.text).toBe(
      "The server owner has not allowed custom addresses.",
    );
  });
});

describe("other actions", () => {
  it("pauses, tests, retries and disconnects through the right routes", async () => {
    api.mockImplementation(async (route: string) =>
      route.endsWith("/test") ? { message: "Connection works." } : status(),
    );
    await useScrobblers.getState().setEnabled("listenbrainz", false);
    expect(api).toHaveBeenCalledWith("api/scrobblers/listenbrainz", {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    await useScrobblers.getState().test("listenbrainz");
    expect(useScrobblers.getState().messages.listenbrainz?.text).toBe(
      "Connection works.",
    );
    await useScrobblers.getState().retryNow("listenbrainz");
    expect(api).toHaveBeenCalledWith(
      "api/scrobblers/queue/retry",
      expect.objectContaining({ method: "POST" }),
    );
    await useScrobblers.getState().disconnect("listenbrainz");
    expect(api).toHaveBeenCalledWith("api/scrobblers/listenbrainz", {
      method: "DELETE",
    });
  });

  it("clears a service queue and says how many", async () => {
    api.mockImplementation(async (route: string) =>
      route.startsWith("api/scrobblers/queue") ? { cleared: 3 } : status(),
    );
    await useScrobblers.getState().clearQueue("lastfm");
    expect(api).toHaveBeenCalledWith("api/scrobblers/queue?service=lastfm", {
      method: "DELETE",
    });
    expect(useScrobblers.getState().messages.lastfm?.text).toBe(
      "Cleared 3 waiting plays.",
    );
  });

  it("reset forgets everything (sign-out)", async () => {
    api.mockResolvedValue(status());
    await useScrobblers.getState().refresh();
    useScrobblers.getState().reset();
    expect(useScrobblers.getState().status).toBeNull();
    expect(useScrobblers.getState().approvals).toEqual({});
  });
});

describe("owner settings", () => {
  it("saves and reloads", async () => {
    api.mockImplementation(async (route: string) => {
      if (route.endsWith("admin/config") && api.mock.calls.length > 0)
        return {
          lastfm: { apiKey: "k", hasSecret: true },
          librefm: null,
          allowCustomHosts: false,
          retryDays: 7,
        };
      return status();
    });
    expect(
      await useScrobblers
        .getState()
        .saveAdmin({ lastfm: { apiKey: "k", apiSecret: "s" } }),
    ).toBe(true);
    expect(useScrobblers.getState().admin?.lastfm?.apiKey).toBe("k");
  });

  it("keeps the server's reason when saving fails", async () => {
    api.mockRejectedValue(
      new Error("Request failed (400): Enter the Last.fm shared secret."),
    );
    expect(
      await useScrobblers.getState().saveAdmin({ lastfm: { apiKey: "k" } }),
    ).toBe(false);
    expect(useScrobblers.getState().error).toBe(
      "Enter the Last.fm shared secret.",
    );
  });
});
