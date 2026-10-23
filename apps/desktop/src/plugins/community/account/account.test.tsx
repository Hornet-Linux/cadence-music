import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useServer } from "../../builtins/server/serverStore";
import { emptyContributions, usePluginHost } from "../../host";
import {
  agoText,
  changePassword,
  deleteAccount,
  endOtherSessions,
  endSession,
  friendlyError,
  loadSessions,
  passwordProblem,
} from "./accountApi";
import { AccountSettings } from "./AccountSettings";
import accountPlugin from "./index";

const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const account = {
  user: { id: 1, username: "ann", displayName: "Ann", email: null, isAdmin: false },
  createdAt: Date.UTC(2026, 0, 5),
  signIn: { password: true, sso: null },
  counts: { plays: 12, likes: 3, playlists: 1 },
  connections: { jellyfin: null },
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useServer.setState({ url: "https://cadence.example", token: "tok", user: { id: 1, username: "ann" } as never });
});
afterEach(() => vi.unstubAllGlobals());

describe("account api", () => {
  it("sends the right requests to the server", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      void init;
      return json(200, { ok: true, signedOut: 2, items: [], deleted: 0 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await changePassword("old-password", "new-password-123");
    await loadSessions();
    await endOtherSessions();
    const calls = fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${new URL(url).pathname}`);
    expect(calls).toEqual(["POST /api/me/password", "GET /api/me/sessions", "POST /api/me/sessions/sign-out-others"]);
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({ currentPassword: "old-password", newPassword: "new-password-123" });
    expect((fetchMock.mock.calls[0]![1]!.headers as Headers).get("authorization")).toBe("Bearer tok");
  });

  it("escapes a session id and deletes by it", async () => {
    const fetchMock = vi.fn(async () => json(204, null));
    vi.stubGlobal("fetch", fetchMock);
    await endSession("a/b c");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/api/me/sessions/a%2Fb%20c");
    expect(init.method).toBe("DELETE");
  });

  it("turns server error codes into plain sentences", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(403, { error: "wrong_password" })));
    const err = await changePassword("x", "y").catch((e: unknown) => e);
    expect(friendlyError(err)).toBe("That isn't your current password.");
    expect(useServer.getState().token).toBe("tok");
    vi.stubGlobal("fetch", vi.fn(async () => json(409, { error: "last_admin" })));
    expect(friendlyError(await deleteAccount({ password: "p" }).catch((e: unknown) => e))).toMatch(/only admin/);
    expect(friendlyError(new Error("boom"))).toBe("boom");
    expect(friendlyError("odd")).toBe("Something went wrong.");
  });
});

describe("helpers", () => {
  it("checks a new password the way the server does", () => {
    expect(passwordProblem("short", "")).toMatch(/10 characters/);
    expect(passwordProblem("long-enough-1", "different")).toMatch(/don't match/);
    expect(passwordProblem("long-enough-1", "long-enough-1")).toBeNull();
    expect(passwordProblem("", "")).toBeNull();
  });

  it("describes when a device was last active", () => {
    const now = Date.UTC(2026, 5, 1, 12);
    expect(agoText(now - 5_000, now)).toBe("just now");
    expect(agoText(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(agoText(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(agoText(now - 2 * 86_400_000, now)).toBe("2 d ago");
  });
});

describe("account plugin", () => {
  it("adds an Account settings panel", async () => {
    usePluginHost.setState({ plugins: [], contributions: emptyContributions() });
    usePluginHost.getState().register(accountPlugin);
    await usePluginHost.getState().setEnabled("cadence.account", true);
    const panels = usePluginHost.getState().contributions.settings;
    expect(panels.map((p) => p.id)).toContain("account");
    expect(accountPlugin.manifest.builtin).toBe(true);
  });
});

describe("account settings panel", () => {
  async function render(user: unknown) {
    useServer.setState({ user: user as never });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<AccountSettings />));
    await act(async () => undefined);
    return { host, unmount: () => act(async () => root.unmount()) };
  }

  it("asks you to sign in to the server first", async () => {
    const { host, unmount } = await render(null);
    expect(host.textContent).toMatch(/Sign in to your Cadence server/);
    await unmount();
  });

  it("shows profile, password, devices and data for a signed-in person", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/api/me/account") return json(200, account);
        if (path === "/api/me/sessions")
          return json(200, { items: [{ id: "abc", device: "Chrome on Windows", ip: null, createdAt: 1, lastUsedAt: Date.now(), current: true }] });
        return json(404, {});
      }),
    );
    const { host, unmount } = await render({ id: 1, username: "ann" });
    const text = host.textContent ?? "";
    expect(text).toContain("Ann");
    expect(text).toContain("Change password");
    expect(text).toContain("Chrome on Windows");
    expect(text).toContain("This device");
    expect(text).toContain("Download my data");
    expect(text).toContain("12 plays");
    expect(host.querySelector('input[aria-label="Current password"]')).not.toBeNull();
    await unmount();
  });

  it("hides the password form for single sign-on accounts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        new URL(url).pathname === "/api/me/account"
          ? json(200, { ...account, signIn: { password: false, sso: "Authentik" } })
          : json(200, { items: [] }),
      ),
    );
    const { host, unmount } = await render({ id: 1, username: "ann" });
    expect(host.textContent).toContain("Authentik");
    expect(host.textContent).not.toContain("Change password");
    await unmount();
  });
});