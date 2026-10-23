import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Config, OidcConfig } from "../config.js";
import type { Db } from "../db.js";
import { OidcClient, type FetchFn } from "./oidc.js";

/**
 * Single sign-on settings saved from the admin panel. Each OIDC_* variable that
 * is set in the environment wins over (and locks) the matching saved field, so
 * existing .env setups behave exactly as before. Changes apply to the next
 * sign-in without a restart: the routes resolve the provider per request.
 */

export const OIDC_FIELDS = [
  "issuer",
  "clientId",
  "clientSecret",
  "displayName",
  "scopes",
  "allowedGroups",
  "adminGroups",
] as const;
export type OidcField = (typeof OIDC_FIELDS)[number];
export type OidcSource = "env" | "admin" | "default" | null;

/** What the admin saved. The client secret is stored sealed with the server secret. */
export interface StoredOidc {
  issuer?: string;
  clientId?: string;
  clientSecretSealed?: string;
  displayName?: string;
  scopes?: string;
  allowedGroups?: string[];
  adminGroups?: string[];
}

export const DEFAULT_OIDC_NAME = "Single sign-on";
export const DEFAULT_OIDC_SCOPES = "openid profile email";
const SETTINGS_KEY = "oidc";

// ---- Sealing the client secret ---------------------------------------------
function sealKey(serverSecret: string): Buffer {
  return createHash("sha256").update(`cadence.oidc:${serverSecret}`).digest();
}

export function sealSecret(serverSecret: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKey(serverSecret), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url")}`;
}

/** The plain secret, or null if it was sealed with another server secret (or tampered with). */
export function openSecret(serverSecret: string, sealed: string): string | null {
  if (!sealed.startsWith("v1.")) return null;
  try {
    const raw = Buffer.from(sealed.slice(3), "base64url");
    const decipher = createDecipheriv("aes-256-gcm", sealKey(serverSecret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ---- Storage ----------------------------------------------------------------
export function readStoredOidc(db: Db): StoredOidc {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(SETTINGS_KEY) as
    | { value: string }
    | undefined;
  if (!row) return {};
  try {
    const v = JSON.parse(row.value) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as StoredOidc) : {};
  } catch {
    return {};
  }
}

export function writeStoredOidc(db: Db, value: StoredOidc | null): void {
  if (!value || Object.keys(value).length === 0) {
    db.prepare("DELETE FROM settings WHERE key = ?").run(SETTINGS_KEY);
    return;
  }
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(SETTINGS_KEY, JSON.stringify(value), Date.now());
}

// ---- Effective configuration --------------------------------------------------
export interface EffectiveOidc {
  /** Usable configuration (issuer and client ID known), or null. */
  config: OidcConfig | null;
  source: Record<OidcField, OidcSource>;
  /** A saved client secret exists but can't be opened (SERVER_SECRET changed). */
  secretUnreadable: boolean;
}

function envFields(config: Config): Partial<OidcConfig> {
  // Tests and older callers may only fill `oidc`: treat all of it as coming from the environment.
  return config.oidcEnv ?? config.oidc ?? {};
}

export function effectiveOidc(config: Config, db: Db, serverSecret: string): EffectiveOidc {
  const env = envFields(config);
  const saved = readStoredOidc(db);
  const source = {} as Record<OidcField, OidcSource>;

  const str = (field: "issuer" | "clientId" | "displayName" | "scopes", fallback?: string) => {
    const e = env[field];
    if (e) {
      source[field] = "env";
      return e;
    }
    const s = saved[field];
    if (s) {
      source[field] = "admin";
      return s;
    }
    source[field] = fallback ? "default" : null;
    return fallback;
  };
  const groups = (field: "allowedGroups" | "adminGroups"): string[] => {
    const e = env[field];
    if (e && e.length) {
      source[field] = "env";
      return e;
    }
    const s = saved[field];
    if (s && s.length) {
      source[field] = "admin";
      return s;
    }
    source[field] = null;
    return [];
  };

  const issuer = str("issuer");
  const clientId = str("clientId");
  const displayName = str("displayName", DEFAULT_OIDC_NAME) ?? DEFAULT_OIDC_NAME;
  const scopes = str("scopes", DEFAULT_OIDC_SCOPES) ?? DEFAULT_OIDC_SCOPES;
  const allowedGroups = groups("allowedGroups");
  const adminGroups = groups("adminGroups");

  let clientSecret: string | undefined;
  let secretUnreadable = false;
  if (env.clientSecret) {
    clientSecret = env.clientSecret;
    source.clientSecret = "env";
  } else if (saved.clientSecretSealed) {
    const plain = openSecret(serverSecret, saved.clientSecretSealed);
    if (plain === null) secretUnreadable = true;
    clientSecret = plain ?? undefined;
    source.clientSecret = "admin";
  } else {
    source.clientSecret = null;
  }

  return {
    config:
      issuer && clientId
        ? { issuer, clientId, clientSecret, displayName, scopes, allowedGroups, adminGroups }
        : null,
    source,
    secretUnreadable,
  };
}

export interface ActiveOidc {
  client: OidcClient;
  config: OidcConfig;
}

/**
 * Returns the provider in effect right now (or null). The client, with its
 * cached discovery document, is reused until the settings change.
 */
export function oidcResolver(
  config: Config,
  db: Db,
  serverSecret: string,
  fetchFn?: FetchFn,
): () => ActiveOidc | null {
  let cached: { key: string; active: ActiveOidc } | null = null;
  return () => {
    if (!config.publicUrl) return null;
    const eff = effectiveOidc(config, db, serverSecret).config;
    if (!eff) {
      cached = null;
      return null;
    }
    const key = JSON.stringify(eff);
    if (cached?.key !== key) {
      cached = {
        key,
        active: {
          config: eff,
          client: new OidcClient(eff, `${config.publicUrl}/api/auth/oidc/callback`, fetchFn),
        },
      };
    }
    return cached.active;
  };
}

// ---- Admin input ----------------------------------------------------------------
export interface OidcInput {
  issuer?: unknown;
  clientId?: unknown;
  /** A new secret; "" or absent keeps the saved one; null removes it. */
  clientSecret?: unknown;
  displayName?: unknown;
  scopes?: unknown;
  allowedGroups?: unknown;
  adminGroups?: unknown;
}

const MAX_GROUPS = 50;

function groupList(v: unknown): string[] | null {
  const raw = Array.isArray(v) ? (v as unknown[]) : typeof v === "string" ? v.split(",") : v == null ? [] : null;
  if (!raw) return null;
  const out: string[] = [];
  for (const g of raw) {
    if (typeof g !== "string") return null;
    const t = g.trim();
    if (!t) continue;
    if (t.length > 200) return null;
    if (!out.includes(t)) out.push(t);
  }
  return out.length > MAX_GROUPS ? null : out;
}

function text(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > max ? null : t;
}

export function validIssuer(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      (u.protocol === "https:" || u.protocol === "http:") &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
}

/**
 * Merge what the admin sent into the saved settings. Fields locked by the
 * environment are ignored. Returns an error code for bad input.
 */
export function applyOidcInput(
  input: OidcInput,
  saved: StoredOidc,
  locked: Partial<Record<OidcField, boolean>>,
  serverSecret: string,
): { stored: StoredOidc } | { error: string } {
  const next: StoredOidc = { ...saved };
  const limits = [
    ["issuer", 500],
    ["clientId", 200],
    ["displayName", 60],
    ["scopes", 300],
  ] as const;
  for (const [field, max] of limits) {
    if (locked[field]) continue;
    const v = text(input[field], max);
    if (v === null) return { error: `invalid_${field}` };
    if (v === undefined) continue;
    if (v) next[field] = v;
    else delete next[field];
  }
  if (next.issuer && !validIssuer(next.issuer)) return { error: "invalid_issuer" };
  if (next.clientId && /\s/.test(next.clientId)) return { error: "invalid_clientId" };
  if (next.scopes && !next.scopes.split(/\s+/).includes("openid")) return { error: "scopes_need_openid" };

  for (const field of ["allowedGroups", "adminGroups"] as const) {
    if (locked[field] || input[field] === undefined) continue;
    const g = groupList(input[field]);
    if (!g) return { error: `invalid_${field}` };
    if (g.length) next[field] = g;
    else delete next[field];
  }

  if (!locked.clientSecret) {
    const s = input.clientSecret;
    if (s === null) delete next.clientSecretSealed;
    else if (typeof s === "string" && s.trim()) {
      if (s.trim().length > 1000) return { error: "invalid_clientSecret" };
      next.clientSecretSealed = sealSecret(serverSecret, s.trim());
    } else if (s !== undefined && s !== "") {
      return { error: "invalid_clientSecret" };
    }
  }
  return { stored: next };
}

/** Fetch the provider's discovery document, for the admin's "Test connection". */
export async function testDiscovery(
  issuer: string,
  fetchFn: FetchFn = fetch,
  timeoutMs = 5000,
): Promise<{ ok: true; issuer: string; authorizationEndpoint: string } | { ok: false; error: string }> {
  if (!validIssuer(issuer)) return { ok: false, error: "That isn't a valid http(s) address." };
  const client = new OidcClient(
    { issuer, clientId: "test", displayName: "", scopes: "openid", allowedGroups: [], adminGroups: [] },
    "http://127.0.0.1/",
    fetchFn,
    timeoutMs,
  );
  try {
    const doc = await client.discover();
    return { ok: true, issuer: doc.issuer, authorizationEndpoint: doc.authorization_endpoint };
  } catch (err) {
    return { ok: false, error: describeFetchError(err) };
  }
}

/** A short, human message for a failed provider request. */
export function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return "The provider didn't answer in time.";
    const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code) return `${err.message} (${cause.code})`;
    return err.message;
  }
  return "Couldn't reach the provider.";
}
