import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
  /** 0 disables periodic rescans. */
  scanIntervalMinutes: number;
  trustProxy: boolean;
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

  return {
    host: env.HOST?.trim() || "0.0.0.0",
    port,
    dataDir: path.resolve(env.DATA_DIR?.trim() || "./data"),
    musicDir: path.resolve(env.MUSIC_DIR?.trim() || "./music"),
    publicUrl,
    adminUsername: env.ADMIN_USERNAME?.trim() || undefined,
    adminPassword: env.ADMIN_PASSWORD || undefined,
    oidc,
    scanIntervalMinutes: int(env.SCAN_INTERVAL_MINUTES, 60, "SCAN_INTERVAL_MINUTES"),
    trustProxy: (env.TRUST_PROXY ?? "true").toLowerCase() !== "false",
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
