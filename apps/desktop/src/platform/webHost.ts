import type { AuthResponse } from "@uma/shared";
import type { HostBridge } from "../../electron/preload";
import type { CadenceNativeBridge } from "../host";
import { createLlmProvider } from "../../electron/llm";
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

interface SpotifySession {
  clientId: string;
  refreshToken: string;
}

let access: { accessToken: string; expiresAt: number } | null = null;
let refreshing: Promise<{ accessToken: string; expiresAt: number } | null> | null = null;

function spotifySession(): SpotifySession | null {
  try {
    const raw = localStorage.getItem(SPOTIFY_KEY);
    return raw ? (JSON.parse(raw) as SpotifySession) : null;
  } catch {
    return null;
  }
}

async function spotifyTokenRequest(params: Record<string, string>) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!res.ok || !body.access_token) {
    const err = new Error(`Spotify sign-in failed (${body.error ?? res.status})`) as Error & { reason?: string };
    err.reason = body.error;
    throw err;
  }
  return body as { access_token: string; refresh_token?: string; expires_in: number };
}

function rememberSpotify(clientId: string, tokens: { access_token: string; refresh_token?: string; expires_in: number }) {
  const previous = spotifySession();
  const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
  if (!refreshToken) throw new Error("Spotify did not return a refresh token");
  localStorage.setItem(SPOTIFY_KEY, JSON.stringify({ clientId, refreshToken }));
  access = { accessToken: tokens.access_token, expiresAt: Date.now() + Math.max(60, tokens.expires_in) * 1000 };
  return access;
}

const spotify: HostBridge["spotify"] = {
  async status() {
    const s = spotifySession();
    return { connected: !!s, clientId: s?.clientId ?? null, redirectUri: location.origin + SPOTIFY_CALLBACK };
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
    const s = spotifySession();
    if (!s) return null;
    if (access && access.expiresAt - Date.now() > 60_000) return access;
    if (!refreshing) {
      refreshing = spotifyTokenRequest({ grant_type: "refresh_token", refresh_token: s.refreshToken, client_id: s.clientId })
        .then((tokens) => rememberSpotify(s.clientId, tokens))
        .catch((err: Error & { reason?: string }) => {
          if (err.reason === "invalid_grant") localStorage.removeItem(SPOTIFY_KEY);
          throw err;
        })
        .finally(() => {
          refreshing = null;
        });
    }
    return refreshing;
  },
  async logout() {
    localStorage.removeItem(SPOTIFY_KEY);
    access = null;
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
  status: (config) => createLlmProvider(config).status(),
  chatJson: (config, req) => createLlmProvider(config).chatJson(req),
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
      const res = await fetch(apiUrl(pending.server, "api/auth/exchange"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, code_verifier: pending.verifier }),
      });
      if (!res.ok) throw new RedirectError(res.status === 400 ? "expired" : "failed");
      const result = (await res.json()) as AuthResponse;
      await secrets.set("server.token", result.token);
      localStorage.setItem("server:url", pending.server);
    } else if (path === SPOTIFY_CALLBACK && pending.kind === "spotify" && pending.clientId) {
      const tokens = await spotifyTokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: location.origin + SPOTIFY_CALLBACK,
        client_id: pending.clientId,
        code_verifier: pending.verifier,
      });
      rememberSpotify(pending.clientId, tokens);
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
