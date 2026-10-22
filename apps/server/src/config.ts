import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { parseJellyfinUrl } from "./jellyfin/url.js";

export interface OidcConfig {
  /** Issuer URL, e.g. https://auth.example.com/application/o/music/ */
  issuer: string;
  clientId: string;
  /** Omit for public clients. */
  clientSecret?: string;
  /** Label for the sign-in button in the app, e.g. "Authentik". */
  displayName: string;
  scopes: string;
  /** If set, only members of at least one of these groups may sign in. */
  allowedGroups: string[];
  /** Members of any of these groups become server admins. */
  adminGroups: string[];
}

export interface AppleMusicConfig {
  /** Apple Developer Team ID. */
  teamId: string;
  /** MusicKit key ID. */
  keyId: string;
  /** The MusicKit private key (.p8 contents, PEM). */
  privateKey: string;
}

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  musicDir: string;
  /** Public base URL of this server, e.g. https://music.example.com (required for OIDC). */
  publicUrl?: string;
  adminUsername?: string;
  adminPassword?: string;
  oidc?: OidcConfig;
  /** Spotify app (client) ID offered to desktop apps. Not a secret. */
  spotifyClientId?: string;
  /** Enables Apple Music by letting the server mint MusicKit developer tokens. */
  appleMusic?: AppleMusicConfig;
  /** Self-service sign-up. Absent means closed (only the admin can add people). */
  signup?: { mode: "open" } | { mode: "invite"; inviteCode: string };
  /** Folder with the built web player (served at /app). */
  webDir?: string;
  /** Address of the owner's Jellyfin server. Wins over the admin setting. */
  jellyfinUrl?: string;
  /** Where the sign-up page sends people to download the desktop app. */
  appDownloadUrl?: string;
  /** 0 disables periodic rescans. */
  scanIntervalMinutes: number;
  /**
   * Which proxies' X-Forwarded-For to believe (Fastify's `trustProxy`):
   * false (none), a hop count, or addresses/CIDR ranges.
   */
  trustProxy: boolean | number | string[];
  logLevel: string;
}

type Env = Record<string, string | undefined>;

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function int(value: string | undefined, fallback: number, name: string): number {
  if (value == null || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

const PROXY_KEYWORDS = new Set(["loopback", "linklocal", "uniquelocal"]);

function validProxyEntry(entry: string): boolean {
  if (PROXY_KEYWORDS.has(entry)) return true;
  const [addr, bits, ...rest] = entry.split("/");
  const family = isIP(addr);
  if (rest.length > 0 || family === 0) return false;
  if (bits === undefined) return true;
  return /^\d{1,3}$/.test(bits) && Number(bits) <= (family === 4 ? 32 : 128);
}

/**
 * Proxies on this machine or a private network (loopback, link-local, RFC 1918
 * and unique-local ranges). This is where a reverse proxy normally sits (Caddy
 * on the same host or on the Docker network), and a client on the open
 * internet is never in these ranges, so it can't pass off its own
 * X-Forwarded-For as a proxy's.
 */
export const PRIVATE_PROXIES = ["loopback", "linklocal", "uniquelocal"];

/**
 * TRUST_PROXY: unset = believe X-Forwarded-For only from a proxy on this
 * machine or a private network (PRIVATE_PROXIES). `false`/`0` = trust none; a
 * number = that many hops (only safe if clients can't reach the server
 * directly); otherwise a comma-separated list of proxy addresses, CIDR ranges
 * or the keywords loopback/linklocal/uniquelocal. Trusting every hop would let
 * clients spoof their address and dodge the rate limits, so it is not
 * offered; "true" means the default.
 */
export function parseTrustProxy(value: string | undefined): Config["trustProxy"] {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "" || v === "true") return [...PRIVATE_PROXIES];
  if (v === "false") return false;
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    if (hops > 10) throw new Error("TRUST_PROXY hop count must be between 0 and 10");
    return hops === 0 ? false : hops;
  }
  const entries = list(v);
  if (entries.length === 0 || !entries.every(validProxyEntry)) {
    throw new Error(
      "TRUST_PROXY must be false, a hop count, or a comma-separated list of proxy IPs/CIDR ranges",
    );
  }
  return entries;
}

function parseSignup(env: Env): Config["signup"] {
  const mode = (env.SIGNUP_MODE ?? "closed").trim().toLowerCase();
  if (mode === "" || mode === "closed") return undefined;
  if (mode === "open") return { mode: "open" };
  if (mode === "invite") {
    const inviteCode = env.SIGNUP_INVITE_CODE?.trim();
    if (!inviteCode || inviteCode.length < 6) {
      throw new Error("SIGNUP_MODE=invite needs SIGNUP_INVITE_CODE (at least 6 characters)");
    }
    return { mode: "invite", inviteCode };
  }
  throw new Error("SIGNUP_MODE must be closed, open or invite");
}

export function loadConfig(env: Env = process.env): Config {
  const publicUrl = env.PUBLIC_URL?.trim().replace(/\/+$/, "") || undefined;
  if (publicUrl && !/^https?:\/\//.test(publicUrl)) {
    throw new Error("PUBLIC_URL must start with http:// or https://");
  }

  const issuer = env.OIDC_ISSUER?.trim();
  const clientId = env.OIDC_CLIENT_ID?.trim();
  let oidc: OidcConfig | undefined;
  if (issuer || clientId) {
    if (!issuer || !clientId) throw new Error("OIDC_ISSUER and OIDC_CLIENT_ID must be set together");
    if (!publicUrl) throw new Error("PUBLIC_URL is required when OIDC is configured");
    oidc = {
      issuer,
      clientId,
      clientSecret: env.OIDC_CLIENT_SECRET?.trim() || undefined,
      displayName: env.OIDC_NAME?.trim() || "Single sign-on",
      scopes: env.OIDC_SCOPES?.trim() || "openid profile email",
      allowedGroups: list(env.OIDC_ALLOWED_GROUPS),
      adminGroups: list(env.OIDC_ADMIN_GROUPS),
    };
  }

  const port = int(env.PORT, 8787, "PORT");
  if (port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535");

  const spotifyClientId = env.SPOTIFY_CLIENT_ID?.trim() || undefined;
  if (spotifyClientId && !/^[0-9a-f]{32}$/i.test(spotifyClientId)) {
    throw new Error("SPOTIFY_CLIENT_ID must be the 32-character client ID of a Spotify app");
  }

  const teamId = env.APPLE_MUSIC_TEAM_ID?.trim();
  const keyId = env.APPLE_MUSIC_KEY_ID?.trim();
  const keyFile = env.APPLE_MUSIC_PRIVATE_KEY_FILE?.trim();
  // Allow the key inline with literal "\n" escapes, as env files often store it.
  let privateKey = env.APPLE_MUSIC_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (!privateKey && keyFile) privateKey = fs.readFileSync(keyFile, "utf8").trim();
  let appleMusic: AppleMusicConfig | undefined;
  if (teamId || keyId || privateKey) {
    if (!teamId || !keyId || !privateKey) {
      throw new Error(
        "Apple Music needs APPLE_MUSIC_TEAM_ID, APPLE_MUSIC_KEY_ID and APPLE_MUSIC_PRIVATE_KEY (or _FILE)",
      );
    }
    appleMusic = { teamId, keyId, privateKey };
  }

  let jellyfinUrl: string | undefined;
  if (env.JELLYFIN_URL?.trim()) {
    try {
      jellyfinUrl = parseJellyfinUrl(env.JELLYFIN_URL);
    } catch (e) {
      throw new Error(`JELLYFIN_URL: ${e instanceof Error ? e.message : "invalid address"}`);
    }
  }

  return {
    host: env.HOST?.trim() || "0.0.0.0",
    port,
    dataDir: path.resolve(env.DATA_DIR?.trim() || "./data"),
    musicDir: path.resolve(env.MUSIC_DIR?.trim() || "./music"),
    publicUrl,
    adminUsername: env.ADMIN_USERNAME?.trim() || undefined,
    adminPassword: env.ADMIN_PASSWORD || undefined,
    oidc,
    spotifyClientId,
    appleMusic,
    signup: parseSignup(env),
    jellyfinUrl,
    appDownloadUrl: env.APP_DOWNLOAD_URL?.trim() || undefined,
    webDir: env.WEB_DIR?.trim() || undefined,
    scanIntervalMinutes: int(env.SCAN_INTERVAL_MINUTES, 60, "SCAN_INTERVAL_MINUTES"),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    logLevel: env.LOG_LEVEL?.trim() || "info",
  };
}

/**
 * The server secret signs stream URLs. Use SERVER_SECRET if provided, otherwise
 * generate one on first start and keep it in the data directory.
 */
export function loadOrCreateSecret(dataDir: string, env: Env = process.env): string {
  const fromEnv = env.SERVER_SECRET?.trim();
  if (fromEnv) {
    if (fromEnv.length < 32) throw new Error("SERVER_SECRET must be at least 32 characters");
    return fromEnv;
  }
  const file = path.join(dataDir, "secret.key");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // Not created yet.
  }
  const secret = randomBytes(32).toString("hex");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
