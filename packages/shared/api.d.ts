/**
 * HTTP API contract between the desktop app and the self-hosted server.
 * Type-only: both apps import these with `import type`, so nothing here exists
 * at runtime.
 */

export interface PublicUser {
  id: number;
  username: string;
  displayName: string | null;
  email: string | null;
  isAdmin: boolean;
}

export interface HealthResponse {
  ok: true;
  name: string;
  version: string;
  auth: {
    /** True when at least one account can sign in with a password. */
    password: boolean;
    /** Present when an OIDC provider (e.g. Authentik) is configured. */
    oidc: { name: string } | null;
  };
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface ExchangeRequest {
  /** One-time code the server redirected to the app's loopback address. */
  code: string;
  /** PKCE verifier matching the code_challenge sent to /api/auth/oidc/start. */
  code_verifier: string;
}

export interface AuthResponse {
  token: string;
  user: PublicUser;
}

export interface ServerTrack {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  trackNo: number | null;
  durationSec: number | null;
}

export interface TrackListResponse {
  items: ServerTrack[];
  total: number;
}

export interface StreamUrlResponse {
  /** Signed path relative to the server base URL (no leading slash). */
  path: string;
  /** Unix time (seconds) after which the signed path stops working. */
  expiresAt: number;
}

export interface LibraryStatusResponse {
  scanning: boolean;
  lastScanAt: number | null;
  trackCount: number;
}

export interface ScanResult {
  added: number;
  updated: number;
  removed: number;
  total: number;
}

/** Streaming-service settings the server shares with signed-in apps. */
export interface IntegrationsResponse {
  /** Spotify app (client) ID configured on the server, if any. Not a secret. */
  spotify: { clientId: string } | null;
  /** True when the server can mint Apple Music developer tokens. */
  appleMusic: { available: boolean };
}

export interface AppleMusicTokenResponse {
  /** MusicKit developer token (ES256 JWT) signed with the server's key. */
  token: string;
  /** Unix time (seconds). */
  expiresAt: number;
}

export interface ApiError {
  error: string;
  message?: string;
}
