import { createPkce, loopbackAuthorize, randomState } from "./loopback";
import { deleteSecret, getSecret, setSecret } from "./secrets";

// Spotify sign-in (authorization code + PKCE, no client secret) and token
// management. Refresh tokens stay in the main process, encrypted at rest; the
// renderer only ever receives short-lived access tokens.

/** Fixed because Spotify requires an exact, pre-registered redirect URI. */
export const SPOTIFY_PORT = 43821;
export const SPOTIFY_REDIRECT_URI = `http://127.0.0.1:${SPOTIFY_PORT}/callback`;

const SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-library-read",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-read-playback-state",
  "user-modify-playback-state",
].join(" ");

const SECRET_KEY = "spotify.session";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const CLIENT_ID_RE = /^[0-9a-f]{32}$/i;

interface StoredSession {
  clientId: string;
  refreshToken: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export interface SpotifyAccessToken {
  accessToken: string;
  /** Unix milliseconds. */
  expiresAt: number;
}

export interface SpotifyStatus {
  connected: boolean;
  clientId: string | null;
  redirectUri: string;
}

let session: StoredSession | null | undefined;
let access: SpotifyAccessToken | null = null;
let refreshing: Promise<SpotifyAccessToken | null> | null = null;

function loadSession(): StoredSession | null {
  if (session === undefined) {
    try {
      const raw = getSecret(SECRET_KEY);
      session = raw ? (JSON.parse(raw) as StoredSession) : null;
    } catch {
      session = null;
    }
  }
  return session;
}

function saveSession(next: StoredSession | null) {
  session = next;
  access = null;
  try {
    if (next) setSecret(SECRET_KEY, JSON.stringify(next));
    else deleteSecret(SECRET_KEY);
  } catch (err) {
    // No keychain available: the session lasts until the app closes.
    console.warn("Could not persist the Spotify session", err);
  }
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    let reason = "";
    try {
      reason = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      // Not JSON.
    }
    const err = new Error(`Spotify token request failed (${res.status}${reason ? `: ${reason}` : ""})`);
    (err as Error & { reason?: string }).reason = reason;
    throw err;
  }
  return (await res.json()) as TokenResponse;
}

function remember(clientId: string, tokens: TokenResponse, previousRefresh?: string) {
  const refreshToken = tokens.refresh_token ?? previousRefresh;
  if (!refreshToken) throw new Error("Spotify did not return a refresh token");
  if (!session || session.refreshToken !== refreshToken || session.clientId !== clientId) {
    saveSession({ clientId, refreshToken });
  }
  access = {
    accessToken: tokens.access_token,
    expiresAt: Date.now() + Math.max(60, tokens.expires_in) * 1000,
  };
  return access;
}

export function spotifyStatus(): SpotifyStatus {
  const s = loadSession();
  return { connected: !!s, clientId: s?.clientId ?? null, redirectUri: SPOTIFY_REDIRECT_URI };
}

let loginInProgress = false;

export async function spotifyLogin(clientId: string): Promise<SpotifyStatus> {
  if (!CLIENT_ID_RE.test(clientId)) throw new Error("That doesn't look like a Spotify client ID");
  if (loginInProgress) throw new Error("A Spotify sign-in is already in progress");
  loginInProgress = true;
  try {
    const state = randomState();
    const pkce = createPkce();
    const code = await loopbackAuthorize({
      port: SPOTIFY_PORT,
      state,
      authorizeUrl: (redirectUri) => {
        const url = new URL("https://accounts.spotify.com/authorize");
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", clientId);
        url.searchParams.set("redirect_uri", redirectUri);
        url.searchParams.set("scope", SCOPES);
        url.searchParams.set("state", state);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("code_challenge", pkce.challenge);
        return url.toString();
      },
    });
    const tokens = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: SPOTIFY_REDIRECT_URI,
      client_id: clientId,
      code_verifier: pkce.verifier,
    });
    remember(clientId, tokens);
    return spotifyStatus();
  } finally {
    loginInProgress = false;
  }
}

/** A valid access token, refreshing it when it is about to expire. */
export async function spotifyAccessToken(): Promise<SpotifyAccessToken | null> {
  const s = loadSession();
  if (!s) return null;
  if (access && access.expiresAt - Date.now() > 60_000) return access;
  if (!refreshing) {
    refreshing = tokenRequest({
      grant_type: "refresh_token",
      refresh_token: s.refreshToken,
      client_id: s.clientId,
    })
      .then((tokens) => remember(s.clientId, tokens, s.refreshToken))
      .catch((err: Error & { reason?: string }) => {
        // A revoked or expired refresh token means the user must sign in again.
        if (err.reason === "invalid_grant") saveSession(null);
        throw err;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

export function spotifyLogout(): void {
  saveSession(null);
}
