import { createHmac, randomBytes } from "node:crypto";
import { pkceChallenge, safeEqual } from "../../util/crypto.js";
import { RemoteError } from "../../sources/indexer.js";
import { readBody, request, SourceNetError, type NetPolicy } from "../../sources/net.js";
import type { ProviderId, TokenSet } from "./providers.js";

/*
 * UNTESTED AGAINST THE REAL SERVICES: written from the OAuth 2.0 / PKCE documents of Google and
 * Microsoft and exercised only against test doubles. See providers.ts.
 */

const STATE_TTL_SEC = 10 * 60;

interface StatePayload {
  /** Provider id. */
  p: ProviderId;
  /** Cadence user id the sign-in is for. */
  u: number;
  /** Expiry, epoch seconds. */
  e: number;
  /** Random value the PKCE verifier is derived from. */
  n: string;
}

const hmac = (secret: string, label: string, data: string) => createHmac("sha256", secret).update(`${label}:${data}`).digest("base64url");

/** The PKCE verifier is derived from the state's nonce and the server secret, so the server needs to remember nothing. */
export function verifierFor(secret: string, nonce: string): string {
  return hmac(secret, "cloud-pkce", nonce);
}

/**
 * A signed, expiring `state` value that binds the sign-in to one Cadence user and one provider. The callback
 * arrives without the person's session, so this is what ties it back to them (and stops anyone else from
 * attaching their own cloud account to somebody else's Cadence account).
 */
export function makeState(secret: string, provider: ProviderId, userId: number, nowSec: number): { state: string; verifier: string; challenge: string } {
  const payload: StatePayload = { p: provider, u: userId, e: nowSec + STATE_TTL_SEC, n: randomBytes(16).toString("base64url") };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const verifier = verifierFor(secret, payload.n);
  return { state: `${body}.${hmac(secret, "cloud-state", body)}`, verifier, challenge: pkceChallenge(verifier) };
}

export function readState(secret: string, state: string, nowSec: number): (StatePayload & { verifier: string }) | null {
  const [body, sig] = state.split(".");
  if (!body || !sig || !safeEqual(hmac(secret, "cloud-state", body), sig)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
    if ((p.p !== "google" && p.p !== "microsoft") || !Number.isInteger(p.u) || p.e < nowSec || typeof p.n !== "string") return null;
    return { ...p, verifier: verifierFor(secret, p.n) };
  } catch {
    return null;
  }
}

export function authorizeUrl(opts: {
  authorizeEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  state: string;
  challenge: string;
  extra: Record<string, string>;
}): string {
  const url = new URL(opts.authorizeEndpoint);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", opts.scopes);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  for (const [k, v] of Object.entries(opts.extra)) url.searchParams.set(k, v);
  return url.toString();
}

/** POSTs form fields to a token endpoint and returns the tokens. `invalid_grant` means the sign-in no longer works. */
export async function tokenRequest(endpoint: string, fields: Record<string, string>, policy: NetPolicy, signal?: AbortSignal): Promise<TokenSet> {
  const res = await request(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
    policy,
    signal,
    headerTimeoutMs: 20_000,
    maxRedirects: 0,
  });
  let json: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown };
  try {
    json = JSON.parse((await readBody(res, 1024 * 1024)).toString("utf8")) as typeof json;
  } catch (e) {
    if (e instanceof SourceNetError) throw e;
    throw new RemoteError("bad_response", undefined, res.status);
  }
  if (res.status === 400 || res.status === 401) {
    // invalid_grant: revoked, expired or already used. Anything else here means the app registration is wrong.
    if (json.error === "invalid_grant") throw new RemoteError("needs_reconnect", "invalid_grant", res.status);
    throw new RemoteError("auth_failed", typeof json.error === "string" ? json.error.slice(0, 60) : undefined, res.status);
  }
  if (res.status !== 200 || typeof json.access_token !== "string") throw new RemoteError("upstream", undefined, res.status);
  const expiresIn = Number(json.expires_in);
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
  };
}
