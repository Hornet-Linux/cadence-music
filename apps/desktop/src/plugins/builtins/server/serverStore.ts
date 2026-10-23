import { create } from "zustand";
import type {
  AppleMusicTokenResponse,
  AuthResponse,
  HealthResponse,
  IntegrationsResponse,
  PublicUser,
  ServerTrack,
  StreamUrlResponse,
  TrackListResponse,
} from "@uma/shared";
import type { Track } from "@/shared/types";
import { isWeb } from "@/platform/webHost";
import { friendlyBlock, usePlaybackBlock } from "@/player/playbackBlock";
import { webSessionState } from "@/platform/webSessionState";

const URL_KEY = "server:url";
const TOKEN_KEY = "server.token";
export const SERVER_TRACK_PREFIX = "server:";

/**
 * The web player's session lives in an HttpOnly cookie the page can't read;
 * `token` then holds this marker instead of a real token.
 */
export const WEB_SESSION = "web-session";

/** Headers that authenticate a request to the server, for the app's token or the web player's cookie. */
export function authHeaders(token: string | null): Record<string, string> {
  if (!token) return {};
  // The cookie goes along by itself (same origin); writes must prove they came from this page.
  if (token === WEB_SESSION) return { "x-cadence-csrf": "1" };
  return { authorization: `Bearer ${token}` };
}

/** Sign-in requests from the web player ask for the cookie instead of a token in the reply. */
const signInHeaders = (): Record<string, string> => (isWeb() ? { "x-cadence-session": "cookie" } : {});

type Status = "disconnected" | "checking" | "online" | "offline";

interface ServerState {
  url: string;
  status: Status;
  health: HealthResponse | null;
  token: string | null;
  user: PublicUser | null;
  tracks: Track[];
  total: number;
  /** Streaming-service settings shared by the server (Spotify app ID, Apple Music). */
  integrations: IntegrationsResponse | null;
  loading: boolean;
  busy: boolean;
  error: string | null;

  init: () => Promise<void>;
  connect: (url: string) => Promise<void>;
  loginPassword: (username: string, password: string) => Promise<void>;
  /** Create the first admin on a new server using its one-time setup code. */
  setupAdmin: (setupCode: string, username: string, password: string) => Promise<void>;
  /** Create an account on a server that allows sign-up. */
  register: (input: { username: string; password: string; inviteCode?: string }) => Promise<void>;
  loginOidc: () => Promise<void>;
  logout: () => Promise<void>;
  loadTracks: () => Promise<void>;
  rescan: () => Promise<void>;
  /** Resolve a server track id to a signed, playable URL. */
  streamUrl: (serverTrackId: string) => Promise<string | null>;
  /** A MusicKit developer token minted by the server. */
  appleMusicToken: () => Promise<AppleMusicTokenResponse>;
  /** Authenticated call to the server API (route relative to the base URL). */
  api: <T>(route: string, init?: RequestInit) => Promise<T>;
}

/** A failed API call, with the HTTP status and the server's `error` code (e.g. "jellyfin_session_expired"). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * A 401 from a Jellyfin route (expired Jellyfin session, wrong Jellyfin
 * password) is about Jellyfin, not "your Cadence session ended". Only the
 * server's own "unauthorized" answer signs the person out.
 */
const isJellyfinRoute = (route: string) => route.replace(/^\/+/, "").startsWith("api/jellyfin/");

async function errorCode(res: Response): Promise<string | undefined> {
  try {
    return ((await res.clone().json()) as { error?: string }).error;
  } catch {
    return undefined;
  }
}

/**
 * Every route follows the same rule: a plugin that answers 401 with its own error code
 * (a wrong Audiobookshelf password, an expired service session) is talking about that
 * service, so it must not sign the person out of Cadence.
 */
export async function endsCadenceSession(route: string, res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  const code = await errorCode(res);
  return isJellyfinRoute(route) ? code === "unauthorized" : code === undefined || code === "unauthorized";
}

export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  return url.toString().replace(/\/+$/, "");
}

export function apiUrl(base: string, route: string): string {
  return new URL(route.replace(/^\/+/, ""), `${base}/`).toString();
}

export function isInsecureRemote(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

function toTrack(t: ServerTrack): Track {
  const artist = t.artist ?? t.albumArtist;
  return {
    id: `${SERVER_TRACK_PREFIX}${t.id}`,
    title: t.title,
    artists: [{ id: artist ?? "unknown", name: artist ?? "Unknown artist" }],
    album: t.album ?? undefined,
    durationSec: t.durationSec ?? undefined,
    source: "server",
  };
}

function readSavedUrl(): string {
  try {
    return localStorage.getItem(URL_KEY) ?? "";
  } catch {
    return "";
  }
}

async function saveToken(token: string | null): Promise<void> {
  const secrets = window.host?.secrets;
  if (!secrets) return;
  // The web player never stores a token: the cookie is the session.
  if (isWeb()) {
    await secrets.delete(TOKEN_KEY).catch(() => undefined);
    return;
  }
  try {
    if (token) await secrets.set(TOKEN_KEY, token);
    else await secrets.delete(TOKEN_KEY);
  } catch (err) {
    // Secure storage unavailable (e.g. no keyring on Linux): keep the token for
    // this session only.
    console.warn("Could not persist the server token", err);
  }
}

/**
 * The web player's session: the HttpOnly cookie if there is one. A token an
 * older version left in localStorage is moved into the cookie and forgotten.
 */
async function webSession(url: string, legacyToken: string | null): Promise<string | null> {
  try {
    if (legacyToken) {
      const res = await fetch(apiUrl(url, "api/auth/web-session"), {
        method: "POST",
        headers: { authorization: `Bearer ${legacyToken}`, "x-cadence-session": "cookie" },
      });
      await window.host?.secrets.delete(TOKEN_KEY).catch(() => undefined);
      if (res.ok) return WEB_SESSION;
    }
    const res = await fetch(apiUrl(url, "api/auth/session"));
    const body = res.ok ? ((await res.json()) as { user: PublicUser | null }) : null;
    return body?.user ? WEB_SESSION : null;
  } catch {
    return null;
  }
}

export const useServer = create<ServerState>((set, get) => {
  queueMicrotask(() => useServer.subscribe((st) => (webSessionState.signedIn = st.token === WEB_SESSION)));
  async function request<T>(route: string, init: RequestInit = {}): Promise<T> {
    const { url, token } = get();
    if (!url) throw new Error("No server configured");
    const headers = new Headers(init.headers);
    for (const [k, v] of Object.entries(authHeaders(token))) headers.set(k, v);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const res = await fetch(apiUrl(url, route), { ...init, headers });
    if (token && (await endsCadenceSession(route, res))) {
      set({ token: null, user: null, tracks: [], total: 0, integrations: null });
      void saveToken(null);
      throw new Error("Your session expired. Sign in again.");
    }
    if (!res.ok) {
      let detail = "";
      let code: string | undefined;
      try {
        const body = (await res.json()) as { error?: string; message?: string };
        code = body.error;
        detail = body.message ? `: ${body.message}` : body.error ? `: ${body.error.replace(/_/g, " ")}` : "";
      } catch {
        // Not JSON.
      }
      throw new ApiError(`Request failed (${res.status})${detail}`, res.status, code);
    }
    if (res.status === 204 || res.status === 202) return undefined as T;
    return (await res.json()) as T;
  }

  async function signedIn(auth: AuthResponse) {
    // The web player got a cookie and an empty token.
    const token = isWeb() && !auth.token ? WEB_SESSION : auth.token;
    set({ token, user: auth.user, error: null });
    await saveToken(token);
    await get().loadTracks();
  }

  let initialized = false;

  return {
    url: "",
    status: "disconnected",
    health: null,
    token: null,
    user: null,
    tracks: [],
    total: 0,
    integrations: null,
    loading: false,
    busy: false,
    error: null,

    async init() {
      if (initialized) return;
      initialized = true;
      // The web player always talks to the server it was loaded from.
      const url = isWeb() ? location.origin : readSavedUrl();
      if (!url) return;
      let token = (await window.host?.secrets.get(TOKEN_KEY).catch(() => null)) ?? null;
      if (isWeb()) token = await webSession(url, token);
      set({ url, token });
      await get().connect(url);
      // A failed sign-in redirect (web) leaves its reason here.
      const redirectError = sessionStorage.getItem("auth:error");
      if (redirectError) {
        sessionStorage.removeItem("auth:error");
        set({ error: redirectError });
      }
    },

    async connect(input) {
      let url: string;
      try {
        url = normalizeServerUrl(input);
      } catch {
        set({ error: "That doesn't look like a valid server address." });
        return;
      }
      const changed = url !== get().url;
      set({ url, status: "checking", error: null });
      if (changed) {
        set({ token: null, user: null, tracks: [], total: 0, integrations: null });
        void saveToken(null);
      }
      try {
        localStorage.setItem(URL_KEY, url);
      } catch {
        // Storage unavailable; the URL lasts for this session.
      }
      try {
        const health = await request<HealthResponse>("api/health");
        set({ health, status: "online" });
      } catch (err) {
        set({ status: "offline", health: null, error: `Can't reach the server. ${(err as Error).message}` });
        return;
      }
      if (get().token) {
        try {
          const user = await request<PublicUser>("api/me");
          set({ user });
          await get().loadTracks();
        } catch (err) {
          set({ error: (err as Error).message });
        }
      }
    },

    async loginPassword(username, password) {
      set({ busy: true, error: null, token: null });
      try {
        const auth = await request<AuthResponse>("api/auth/login", {
          method: "POST",
          headers: signInHeaders(),
          body: JSON.stringify({ username, password }),
        });
        await signedIn(auth);
      } catch (err) {
        const message = (err as Error).message;
        set({
          error: message.includes("401") ? "Wrong username or password." : message,
        });
      } finally {
        set({ busy: false });
      }
    },

    async register({ username, password, inviteCode }) {
      set({ busy: true, error: null, token: null });
      try {
        const auth = await request<AuthResponse>("api/auth/register", {
          method: "POST",
          headers: signInHeaders(),
          body: JSON.stringify({ username: username.trim(), password, inviteCode: inviteCode?.trim() }),
        });
        await signedIn(auth);
      } catch (err) {
        const message = (err as Error).message;
        const friendly: Record<string, string> = {
          "username taken": "That username is taken. Try another.",
          "invalid username": "Usernames can use letters, numbers, dots, dashes, underscores and @.",
          "weak password": "Use a password of at least 10 characters.",
          "invalid invite code": "That invite code isn't right.",
          "signup closed": "This server isn't accepting new accounts.",
          "too many attempts": "Too many attempts. Try again later.",
        };
        const key = Object.keys(friendly).find((k) => message.includes(k));
        set({ error: key ? friendly[key] : message });
      } finally {
        set({ busy: false });
      }
    },

    async setupAdmin(setupCode, username, password) {
      set({ busy: true, error: null, token: null });
      try {
        const auth = await request<AuthResponse>("api/setup/admin", {
          method: "POST",
          headers: signInHeaders(),
          body: JSON.stringify({ setupCode: setupCode.trim(), username: username.trim(), password }),
        });
        const health = get().health;
        if (health) set({ health: { ...health, setupRequired: false, auth: { ...health.auth, password: true } } });
        await signedIn(auth);
      } catch (err) {
        const message = (err as Error).message;
        set({
          error: message.includes("invalid setup code")
            ? "That setup code isn't right. Copy it again from the server logs."
            : message.includes("weak password")
              ? "Use a password of at least 10 characters."
              : message.includes("invalid username")
                ? "Usernames can use letters, numbers, dots, dashes, underscores and @."
                : message.includes("already set up")
                  ? "This server already has an admin. Sign in instead."
                  : message,
        });
      } finally {
        set({ busy: false });
      }
    },

    async loginOidc() {
      const { url } = get();
      if (!url || !window.host?.auth) return;
      set({ busy: true, error: null });
      try {
        await signedIn(await window.host.auth.oidcLogin(url));
      } catch (err) {
        set({ error: (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") });
      } finally {
        set({ busy: false });
      }
    },

    async logout() {
      // Plays not yet uploaded are this person's; send them before the session ends (web clears them).
      if (isWeb() && get().user) {
        const { uploadPendingPlays } = await import("./historySync");
        await Promise.race([uploadPendingPlays(), new Promise((r) => setTimeout(r, 3000))]).catch(() => undefined);
      }
      try {
        if (get().token) await request<void>("api/auth/logout", { method: "POST" });
      } catch {
        // Sign out locally regardless.
      }
      set({ token: null, user: null, tracks: [], total: 0, integrations: null });
      await saveToken(null);
      // The website shares one browser between people: leave nothing of this
      // person's Spotify, Apple Music or AI provider setup behind.
      if (isWeb()) {
        try {
          const { clearWebDeviceData } = await import("@/platform/webSignOut");
          await clearWebDeviceData();
        } catch (err) {
          console.warn("Could not clear this browser's streaming data", err);
        }
      }
    },

    async loadTracks() {
      if (!get().token) return;
      set({ loading: true });
      // Older servers have no integrations endpoint; that's not an error.
      void request<IntegrationsResponse>("api/integrations")
        .then((integrations) => set({ integrations }))
        .catch(() => set({ integrations: null }));
      try {
        const page = await request<TrackListResponse>("api/tracks?limit=5000");
        set({ tracks: page.items.map(toTrack), total: page.total, error: null });
      } catch (err) {
        set({ error: (err as Error).message });
      } finally {
        set({ loading: false });
      }
    },

    async rescan() {
      set({ busy: true, error: null });
      try {
        await request("api/library/scan?wait=1", { method: "POST" });
        await get().loadTracks();
      } catch (err) {
        set({ error: (err as Error).message });
      } finally {
        set({ busy: false });
      }
    },

    async streamUrl(serverTrackId) {
      if (!get().token) return null;
      let signed: StreamUrlResponse;
      try {
        signed = await request<StreamUrlResponse>(`api/tracks/${encodeURIComponent(serverTrackId)}/stream-url`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 429) usePlaybackBlock.getState().set(friendlyBlock(err.code, err.message.replace(/^Request failed (d+): ?/, "")));
        throw err;
      }
      usePlaybackBlock.getState().set(null);
      return apiUrl(get().url, signed.path);
    },

    appleMusicToken() {
      return request<AppleMusicTokenResponse>("api/integrations/apple-music/token");
    },

    api: request,
  };
});
