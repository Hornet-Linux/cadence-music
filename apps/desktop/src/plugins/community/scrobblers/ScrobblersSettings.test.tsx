// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useServer } from "../../builtins/server/serverStore";
import type { ServiceStatus, StatusResponse } from "./logic";
import { ScrobblersSettings } from "./ScrobblersSettings";
import { useScrobblers } from "./scrobblersStore";
import scrobblersPlugin from "./index";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const svc = (
  id: ServiceStatus["id"],
  label: string,
  extra: Partial<ServiceStatus> = {},
): ServiceStatus => ({
  id,
  label,
  available: true,
  connected: false,
  enabled: false,
  needsReauth: false,
  awaitingApproval: false,
  sent: 0,
  queue: { pending: 0, sentToday: 0, dropped: 0, nextAttemptAt: null },
  ...extra,
});

const status: StatusResponse = {
  services: [
    svc("lastfm", "Last.fm", {
      available: false,
      unavailableReason: "The server owner has not added Last.fm API keys yet.",
    }),
    svc("listenbrainz", "ListenBrainz", {
      connected: true,
      enabled: true,
      username: "rj",
      lastSuccessAt: Date.now() - 120_000,
      lastError: {
        message: "ListenBrainz had a problem (HTTP 503).",
        at: Date.now() - 60_000,
      },
      queue: {
        pending: 2,
        sentToday: 4,
        dropped: 0,
        nextAttemptAt: Date.now() + 60_000,
      },
    }),
    svc("maloja", "Maloja"),
  ],
  customHostsAllowed: true,
  retryDays: 7,
  problems: [],
  isAdmin: false,
};

let host: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(<ScrobblersSettings />);
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  useScrobblers.getState().reset();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("ScrobblersSettings", () => {
  it("explains in one line that a server is needed when signed out", async () => {
    useServer.setState({ user: null, token: null });
    await render();
    expect(host.textContent).toContain("only once you're signed in to one");
    expect(host.querySelectorAll(".scrb-card")).toHaveLength(0);
  });

  it("says the plugin is off when the server has no scrobbling routes", async () => {
    useServer.setState({
      user: {
        id: 1,
        username: "a",
        displayName: null,
        email: null,
        isAdmin: false,
      },
      token: "t",
      api: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("x"), { status: 404 }),
        ) as never,
    });
    useScrobblers.setState({ support: "missing" });
    await render();
    expect(host.textContent).toContain("doesn't have scrobbling turned on");
  });

  it("shows each service with its state, queue and last error, plus forms for unconnected ones", async () => {
    useServer.setState({
      user: {
        id: 1,
        username: "a",
        displayName: null,
        email: null,
        isAdmin: false,
      },
      token: "t",
      api: vi.fn().mockResolvedValue(status) as never,
    });
    useScrobblers.setState({ status, support: "ok" });
    await render();
    const cards = [...host.querySelectorAll(".scrb-card")];
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual([
      "Last.fm",
      "ListenBrainz",
      "Maloja",
    ]);
    expect(cards[0]!.textContent).toContain("has not added Last.fm API keys");
    expect(cards[1]!.textContent).toContain("Retrying, 2 waiting");
    expect(cards[1]!.textContent).toContain("Accountrj");
    expect(cards[1]!.textContent).toContain("isn't answering right now");
    expect(
      [...cards[1]!.querySelectorAll("button")].map((b) => b.textContent),
    ).toEqual(
      expect.arrayContaining([
        "Pause",
        "Test connection",
        "Retry now",
        "Clear queue",
        "Disconnect",
      ]),
    );
    const connect = cards[2]!.querySelector(
      "button[type=submit]",
    ) as HTMLButtonElement;
    expect(connect.textContent).toBe("Connect Maloja");
    expect(connect.disabled).toBe(true);
    expect(cards[2]!.querySelector("#scrb-mj-key")?.getAttribute("type")).toBe(
      "password",
    );
  });
});

describe("plugin", () => {
  it("is an opt-in settings panel plugin", () => {
    expect(scrobblersPlugin.manifest.id).toBe("cadence.scrobblers");
    expect(scrobblersPlugin.manifest.builtin).toBeFalsy();
    expect(scrobblersPlugin.manifest.capabilities).toEqual([
      "ui.settings",
      "network.outbound",
    ]);
  });
});
