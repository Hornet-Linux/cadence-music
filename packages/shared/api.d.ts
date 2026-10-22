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
  /**
   * True on a brand-new server with no accounts: the first admin must be
   * created with the one-time setup code printed in the server's logs.
   */
  setupRequired: boolean;
  auth: {
    /** True when at least one account can sign in with a password. */
    password: boolean;
    /** Present when an OIDC provider (e.g. Authentik) is configured. */
    oidc: { name: string } | null;
    /** Whether people can create their own accounts, and if an invite code is needed. */
    signup: SignupMode;
  };
}

export type SignupMode = "closed" | "open" | "invite";

export interface RegisterRequest {
  username: string;
  /** At least 10 characters. */
  password: string;
  displayName?: string;
  /** Required when the server's sign-up mode is "invite". */
  inviteCode?: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface SetupAdminRequest {
  /** One-time code from the server's logs. */
  setupCode: string;
  username: string;
  /** At least 10 characters. */
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

/** A track as stored in listening history (from any source). */
export interface HistoryTrack {
  /** Source-specific id, e.g. "spotify:track:…", "apple:song:…", "server:…". */
  id: string;
  title: string;
  artists: { id: string; name: string }[];
  album?: string;
  artwork?: string;
  durationSec?: number;
  source?: string;
}

export interface Play {
  track: HistoryTrack;
  /** Unix milliseconds. */
  playedAt: number;
}

export interface RecordPlaysRequest {
  /** Up to 200 plays; duplicates (same track and time) are ignored. */
  plays: Play[];
}

export interface HistoryResponse {
  items: Play[];
}

export interface TopTrack {
  track: HistoryTrack;
  plays: number;
  lastPlayedAt: number;
}

export interface TopTracksResponse {
  items: TopTrack[];
}

/** Streaming-service settings the server shares with signed-in apps. */
export interface IntegrationsResponse {
  /**
   * Spotify app (client) ID, if any. Not a secret. `server`: set by the server
   * owner for everyone; `account`: saved by this person from one of their apps.
   */
  spotify: { clientId: string; source?: "server" | "account" } | null;
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

// ---- Liked songs and playlists ---------------------------------------------

export interface LikesResponse {
  /** Newest first. */
  items: { track: HistoryTrack; likedAt: number }[];
}

export interface PlaylistResponse {
  id: string;
  name: string;
  tracks: HistoryTrack[];
  createdAt: number;
  updatedAt: number;
}

export interface PlaylistsResponse {
  /** Most recently changed first. */
  items: PlaylistResponse[];
}

// ---- AI DJ and LLM providers -------------------------------------------------

export type LlmProviderKind = "ollama" | "openai-compatible" | "anthropic";

/**
 * A provider a signed-in app can pick. `ref` is `server:<id>` for providers the
 * server owner configured (the server calls them; their keys never leave it)
 * or `device:<deviceId>:<providerId>` for a provider running on one of the
 * person's own computers, reached through the server while that app is open.
 */
export interface LlmProviderInfo {
  ref: string;
  name: string;
  kind: LlmProviderKind;
  model: string;
  scope: "server" | "device";
  /** Device providers: the name of the computer they run on. */
  deviceName?: string;
  /** Server providers: the one used when a person hasn't chosen. */
  isDefault?: boolean;
}

export interface LlmProvidersResponse {
  items: LlmProviderInfo[];
}

export interface LlmStatusResponse {
  available: boolean;
  models: string[];
  error?: string;
}

/** A server provider as the admin sees it. The API key is never returned. */
export interface AdminLlmProvider {
  id: string;
  name: string;
  kind: LlmProviderKind;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  enabled: boolean;
  isDefault: boolean;
}

export interface AdminLlmProviderInput {
  name: string;
  kind: LlmProviderKind;
  baseUrl: string;
  model: string;
  /** Omit to keep the saved key; send "" to remove it. */
  apiKey?: string;
  enabled?: boolean;
  isDefault?: boolean;
}

export interface DjTasteProfile {
  topArtists: string[];
  genres: string[];
  /** "Artist – Title" lines. */
  topTracks: string[];
  recentTracks: string[];
}

export interface DjPicksRequest {
  /** Provider ref; defaults to the server's default provider. */
  provider?: string;
  profile: DjTasteProfile;
  mood?: string;
  switchUp?: boolean;
  /** "Artist – Title" lines already played or queued. */
  avoid?: string[];
  count?: number;
}

export interface DjPicksResponse {
  picks: { artist: string; title: string; intro: string }[];
}

/** Sent by an app that offers its own computer's providers to the person's other devices. */
export interface LlmDeviceRegistration {
  deviceId: string;
  /** Shown in the provider list, e.g. "Desktop". */
  name: string;
  /** No keys or URLs: only what other devices need to show a choice. */
  providers: { id: string; name: string; kind: LlmProviderKind; model: string }[];
}

/** A request the server forwards to the device that owns the provider. */
export interface LlmRelayJob {
  jobId: string;
  providerId: string;
  op: "status" | "chat-json";
  request?: { messages: { role: "system" | "user" | "assistant"; content: string }[]; schema: Record<string, unknown>; temperature?: number };
}

export type LlmRelayResult = { ok: true; data: unknown } | { ok: false; error: string };
