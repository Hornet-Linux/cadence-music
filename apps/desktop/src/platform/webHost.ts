import { webSessionState } from "./webSessionState";
import type { AuthResponse } from "@uma/shared";
import type { HostBridge } from "../../electron/preload";
import type { CadenceNativeBridge } from "../host";
import { createLlmProvider } from "../../electron/llm";
import { hasKey, resolveConfig, saveKey } from "../../electron/llmKeys";
import { authNoticeFor, showAuthNotice } from "./authNotice";

// Browser stand-in for the Electron preload bridge (window.host), so the same
// UI runs as a website served by the Cadence server at /app. Differences:
// - secrets live in localStorage (like any web app's session)
// - sign-ins (server OIDC, Spotify) use full-page redirects back to /app
// - window controls don't exist

const BASE = "/app";
export const OIDC_CALLBACK = `${BASE}/auth/callback`;
export const SPOTIFY_CALLBACK = `${BASE}/spotify/callback`;
const PENDING_KEY = "auth:pending";
const SPOTIFY_KEY = "secret:spotify.session";
const SPOTIFY_SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-library-read",
  "user-top-read",
  "user-read-recently-played",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-read-playback-state",
  "user-modify-playback-state",
].join(" ");

interface Pending {
  kind: "oidc" | "spotify";
  state: string;
  verifier: string;
  server?: string;
  clientId?: string;
}

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

function randomString(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function challengeFor(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

function apiUrl(base: string, route: string): string {
  return new URL(route.replace(/^\/+/, ""), base.endsWith("/") ? base : `${base}/`).toString();
}

const secrets = {
  async get(key: string) {
    return localStorage.getItem(`secret:${key}`);
  },
  async set(key: string, value: string) {
    localStorage.setItem(`secret:${key}`, value);
  },
  async delete(key: string) {
    localStorage.removeItem(`secret:${key}`);
  },
};

// ---- Spotify (authorization code + PKCE, no client secret) -----------------

// The Spotify connection belongs to the Cadence account and lives on the
// server: it redeems the sign-in code and keeps the refresh token, and this
// page only gets short-lived access tokens (POST /api/me/spotify/token).

let access: { accessToken: string; expiresAt: number } | null = null;
let refreshing: Promise<{ accessToken: string; expiresAt: number } | null> | null = null;

/** Calls this server's API with the web player's session cookie. */
async function serverCall<T>(route: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: T | null }> {
  const res = await fetch(apiUrl(location.origin, route), {
    ...init,
    headers: { "x-cadence-csrf": "1", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
  });
  const body = res.status === 204 ? null : ((await res.json().catch(() => null)) as T | null);
  return { ok: res.ok, status: res.status, body };
}

/** A refresh token an older version kept in this browser moves to the server once. */
async function importLegacySpotify(): Promise<void> {
  let legacy: { clientId?: string; refreshToken?: string } | null = null;
  try {
    legacy = JSON.parse(localStorage.getItem(SPOTIFY_KEY) ?? "null");
  } catch {
    legacy = null;
  }
  if (!legacy) return;
  localStorage.removeItem(SPOTIFY_KEY);
  if (legacy.clientId && legacy.refreshToken) {
    await serverCall("api/me/spotify/import", { method: "POST", body: JSON.stringify(legacy) }).catch(() => undefined);
  }
}

const spotify: HostBridge["spotify"] = {
  async status() {
    if (!webSessionState.signedIn) return { connected: false, clientId: null, redirectUri: location.origin + SPOTIFY_CALLBACK };
    await importLegacySpotify();
    const r = await serverCall<{ connected: boolean; clientId: string | null }>("api/me/spotify").catch(() => null);
    const s = r?.ok ? r.body : null;
    return { connected: !!s?.connected, clientId: s?.clientId ?? null, redirectUri: location.origin + SPOTIFY_CALLBACK };
  },
  async login(clientId: string) {
    const id = clientId.trim();
    if (!/^[0-9a-f]{32}$/i.test(id)) throw new Error("That doesn't look like a Spotify client ID");
    const pending: Pending = { kind: "spotify", state: randomString(16), verifier: randomString(32), clientId: id };
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    const url = new URL("https://accounts.spotify.com/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", id);
    url.searchParams.set("redirect_uri", location.origin + SPOTIFY_CALLBACK);
    url.searchParams.set("scope", SPOTIFY_SCOPES);
    url.searchParams.set("state", pending.state);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("code_challenge", await challengeFor(pending.verifier));
    location.assign(url.toString());
    return new Promise<never>(() => undefined); // the page navigates away
  },
  async token() {
    if (!webSessionState.signedIn) return null;
    if (access && access.expiresAt - Date.now() > 60_000) return access;
    if (!refreshing) {
      refreshing = (async () => {
        await importLegacySpotify();
        const r = await serverCall<{ accessToken: string; expiresAt: number; reason?: string }>("api/me/spotify/token", { method: "POST" });
        if (r.status === 404 || r.status === 401) return null; // not connected, or signed out
        if (!r.ok || !r.body?.accessToken) throw new Error(`Spotify sign-in failed (${r.body?.reason ?? r.status})`);
        access = { accessToken: r.body.accessToken, expiresAt: r.body.expiresAt };
        return access;
      })().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  },
  async logout() {
    // Disconnects Spotify from the account. On sign-out the session is already
    // gone, so this only forgets the access token held by this page.
    access = null;
    localStorage.removeItem(SPOTIFY_KEY);
    await serverCall("api/me/spotify", { method: "DELETE" }).catch(() => undefined);
  },
};

// ---- Server sign-in through its OIDC provider ------------------------------

const auth: HostBridge["auth"] = {
  async oidcLogin(serverUrl: string): Promise<AuthResponse> {
    const pending: Pending = { kind: "oidc", state: randomString(16), verifier: randomString(32), server: serverUrl };
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    const start = new URL(apiUrl(serverUrl, "api/auth/oidc/start"));
    start.searchParams.set("redirect_uri", location.origin + OIDC_CALLBACK);
    start.searchParams.set("state", pending.state);
    start.searchParams.set("code_challenge", await challengeFor(pending.verifier));
    // Check first that the server can reach its provider: otherwise the browser
    // would land on a bare error page instead of coming back here.
    const probe = await fetch(start.toString(), { redirect: "manual" }).catch(() => null);
    if (!probe || probe.status >= 500) {
      const notice = authNoticeFor("oidc_unavailable");
      showAuthNotice(notice, () => void auth.oidcLogin(serverUrl).catch(() => undefined));
      throw new Error(notice.text);
    }
    location.assign(start.toString());
    return new Promise<never>(() => undefined); // the page navigates away
  },
};

// ---- LLM (AI DJ) -------------------------------------------------------------
// Called straight from the page; Ollama must allow this origin (OLLAMA_ORIGINS).

const llm: HostBridge["llm"] = {
  status: async (config) => createLlmProvider(await resolveConfig(secrets, config)).status(),
  chatJson: async (config, req) => createLlmProvider(await resolveConfig(secrets, config)).chatJson(req),
  saveKey: (providerId, baseUrl, key) => saveKey(secrets, providerId, baseUrl, key),
  hasKey: (providerId) => hasKey(secrets, providerId),
};

// Desktop-only integrations (Discord, global shortcuts, control API, Slack) do
// nothing in a browser; their plugins are not even loaded here.
const unsupported = async () => {
  throw new Error("Only available in the desktop app");
};
const integrations: HostBridge["integrations"] = {
  discord: {
    start: unsupported,
    setActivity: async () => undefined,
    stop: async () => undefined,
    status: async () => ({ state: "off" }),
    onStatus: () => () => undefined,
  },
  shortcuts: { set: async () => [], clear: async () => undefined, onTriggered: () => () => undefined },
  system: { mediaControls: async () => false, setMediaControls: unsupported, relaunch: async () => undefined },
  control: {
    start: unsupported,
    stop: async () => undefined,
    status: async () => ({ running: false, port: null, clients: 0, token: null }),
    regenerateToken: unsupported,
    pushState: () => undefined,
    setHandler: () => undefined,
  },
  slack: { test: unsupported, setStatus: unsupported, clearStatus: unsupported, forget: async () => undefined },
};

export const webHost: HostBridge = {
  window: { minimize: () => undefined, toggleMaximize: () => undefined, close: () => undefined },
  ui: { setZoom: () => undefined },
  secrets,
  auth,
  spotify,
  llm,
  integrations,
  platform: "web" as unknown as HostBridge["platform"],
};

/** An error code from a sign-in redirect, mapped to a friendly notice. */
class RedirectError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * Finish a sign-in redirect if the page was loaded on a callback URL, then
 * return to /app. Errors are left in sessionStorage for the UI to show.
 */
export async function completeWebRedirects(): Promise<void> {
  const path = location.pathname.replace(/\/+$/, "");
  if (path !== OIDC_CALLBACK && path !== SPOTIFY_CALLBACK) return;
  const params = new URLSearchParams(location.search);
  let pending: Pending | null;
  try {
    pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null") as Pending | null;
  } catch {
    pending = null;
  }
  sessionStorage.removeItem(PENDING_KEY);

  try {
    const error = params.get("error");
    const code = params.get("code");
    if (error) throw new RedirectError(error);
    if (!pending || !code || params.get("state") !== pending.state) throw new RedirectError("expired");

    if (path === OIDC_CALLBACK && pending.kind === "oidc" && pending.server) {
      // The session comes back as an HttpOnly cookie; the page never sees the token.
      const res = await fetch(apiUrl(pending.server, "api/auth/exchange"), {
        method: "POST",
        headers: { "content-type": "application/json", "x-cadence-session": "cookie" },
        body: JSON.stringify({ code, code_verifier: pending.verifier }),
      });
      if (!res.ok) throw new RedirectError(res.status === 400 ? "expired" : "failed");
      localStorage.setItem("server:url", pending.server);
    } else if (path === SPOTIFY_CALLBACK && pending.kind === "spotify" && pending.clientId) {
      // The server redeems the code and keeps the refresh token.
      const r = await serverCall<{ accessToken: string; expiresAt: number; reason?: string }>("api/me/spotify/connect", {
        method: "POST",
        body: JSON.stringify({ code, codeVerifier: pending.verifier, clientId: pending.clientId, redirectUri: location.origin + SPOTIFY_CALLBACK }),
      });
      if (!r.ok || !r.body?.accessToken) throw new Error(`Spotify sign-in failed (${r.body?.reason ?? r.status})`);
      access = { accessToken: r.body.accessToken, expiresAt: r.body.expiresAt };
      localStorage.setItem("spotify:clientId", pending.clientId);
    }
  } catch (err) {
    if (path === OIDC_CALLBACK) {
      const notice = authNoticeFor(err instanceof RedirectError ? err.code : "failed");
      sessionStorage.setItem("auth:error", notice.text);
      const server = pending?.kind === "oidc" ? pending.server : undefined;
      showAuthNotice(notice, server ? () => void auth.oidcLogin(server).catch(() => undefined) : undefined);
    } else {
      const message =
        err instanceof RedirectError
          ? err.code === "access_denied"
            ? "Access denied"
            : err.code === "expired"
              ? "Sign-in link expired. Try again."
              : `Sign-in failed (${err.code})`
          : (err as Error).message;
      sessionStorage.setItem("auth:error", message);
    }
  } finally {
    history.replaceState(null, "", `${BASE}/`);
  }
}

interface NativeBridge {
  postMessage(message: unknown): void;
}

/** The iOS app's message handler, when the web player runs inside it (apps/ios). */
function iosApp(): NativeBridge | undefined {
  return (window as unknown as { webkit?: { messageHandlers?: { cadence?: NativeBridge } } }).webkit?.messageHandlers
    ?.cadence;
}

/** The Android app's bridge, when the web player runs inside it (apps/android). */
function androidApp(): Required<Pick<CadenceNativeBridge, "changeServer">> | undefined {
  const bridge = window.CadenceNative;
  return bridge?.platform === "android" && typeof bridge.changeServer === "function"
    ? { changeServer: () => bridge.changeServer?.() }
    : undefined;
}

/** True inside the iOS or Android app, which can go back to their server address screen. */
export function isNativeApp(): boolean {
  return !!iosApp() || !!androidApp();
}

/** Ask the iOS or Android app to go back to its server address screen. */
export function changeNativeServer(): void {
  const ios = iosApp();
  if (ios) ios.postMessage({ action: "changeServer" });
  else androidApp()?.changeServer();
}

/** True when running as the website rather than the desktop app. */
export function isWeb(): boolean {
  return (window.host?.platform as string | undefined) === "web";
}
