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
  /** A key is saved but can't be decrypted (the server secret changed): enter it again. */
  keyUnreadable?: boolean;
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

// ---- Jellyfin ------------------------------------------------------------------
// The Cadence server talks to Jellyfin on the person's behalf, so every device can
// use it and the Jellyfin token never leaves the server. The server owner sets the
// Jellyfin address (JELLYFIN_URL or the admin API); people only sign in.

export interface JellyfinStatusResponse {
  /** The server owner has set a Jellyfin address. */
  configured: boolean;
  /** This person is signed in to Jellyfin. */
  connected: boolean;
  serverName?: string;
  /** Their Jellyfin user name. */
  userName?: string;
}

/** Sign in to the server's Jellyfin. The password is used once and never stored. */
export interface JellyfinConnectRequest {
  username: string;
  password: string;
}

export interface JellyfinTrack {
  /** The Jellyfin item id. Cadence track ids are `jellyfin:<id>`. */
  id: string;
  title: string;
  artists: string[];
  album?: string;
  albumId?: string;
  durationSec?: number;
  trackNo?: number;
  year?: number;
  /** Signed, relative path (against the server base URL) to the cover image. */
  artwork?: string;
  /** Marked as a favourite in this person's Jellyfin. */
  favourite?: boolean;
}

export interface JellyfinTracksResponse {
  items: JellyfinTrack[];
  total: number;
}

export interface JellyfinAlbum {
  id: string;
  name: string;
  artist?: string;
  year?: number;
  trackCount?: number;
  artwork?: string;
}

export interface JellyfinAlbumsResponse {
  items: JellyfinAlbum[];
  total: number;
}

export interface JellyfinPlaylist {
  id: string;
  name: string;
  trackCount: number;
  artwork?: string;
}

export interface JellyfinPlaylistsResponse {
  items: JellyfinPlaylist[];
}

/** Ask for the library tracks that best match songs an AI picked. */
export interface JellyfinMatchRequest {
  /** Up to 30 picks. */
  picks: { artist: string; title: string }[];
}

export interface JellyfinMatchResponse {
  /** Same length and order as the request; null when nothing in the library matches. */
  matches: (JellyfinTrack | null)[];
}

export interface JellyfinStreamUrlResponse {
  /** Signed, relative path (against the server base URL) that streams the track with Range support. */
  path: string;
  /** Unix time (seconds). */
  expiresAt: number;
}

/** Tell Jellyfin what is playing so play counts and "recently played" stay in sync. */
export interface JellyfinPlaybackReport {
  event: "start" | "progress" | "stop";
  itemId: string;
  positionSec: number;
}

/** What the AI DJ knows about the listener, built from their Jellyfin plays and favourites. */
export type JellyfinTasteResponse = DjTasteProfile;

/** Admin: where the server finds Jellyfin. */
export interface AdminJellyfinResponse {
  serverUrl: string | null;
  /** `env` when JELLYFIN_URL is set (it wins); `admin` when saved from the admin API. */
  source: "env" | "admin" | null;
}

export interface AdminJellyfinTestResponse {
  ok: boolean;
  serverName?: string;
  version?: string;
  error?: string;
}
