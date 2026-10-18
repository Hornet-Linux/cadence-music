import type { OidcConfig } from "../config.js";

export type FetchFn = typeof fetch;

export interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
}

export interface TokenResponse {
  id_token?: string;
  access_token?: string;
}

export type Claims = Record<string, unknown>;

const stripSlash = (s: string) => s.replace(/\/+$/, "");

/**
 * Minimal OpenID Connect relying party for the authorization-code flow with
 * PKCE. The ID token is received directly from the token endpoint over TLS,
 * which OIDC Core §3.1.3.7 allows in place of verifying its signature; the
 * claims (iss, aud, azp, exp, nonce) are still validated.
 */
export class OidcClient {
  private discovery: Promise<DiscoveryDocument> | null = null;

  constructor(
    private readonly config: OidcConfig,
    readonly callbackUrl: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  get displayName(): string {
    return this.config.displayName;
  }

  discover(): Promise<DiscoveryDocument> {
    if (!this.discovery) {
      this.discovery = this.loadDiscovery().catch((err) => {
        this.discovery = null; // retry on the next attempt
        throw err;
      });
    }
    return this.discovery;
  }

  private async loadDiscovery(): Promise<DiscoveryDocument> {
    const url = `${stripSlash(this.config.issuer)}/.well-known/openid-configuration`;
    const res = await this.fetchFn(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
    const doc = (await res.json()) as Partial<DiscoveryDocument>;
    if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint) {
      throw new Error("OIDC discovery document is missing required fields");
    }
    if (stripSlash(doc.issuer) !== stripSlash(this.config.issuer)) {
      throw new Error("OIDC discovery issuer does not match OIDC_ISSUER");
    }
    return doc as DiscoveryDocument;
  }

  async authorizationUrl(params: {
    state: string;
    nonce: string;
    codeChallenge: string;
  }): Promise<string> {
    const doc = await this.discover();
    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.callbackUrl);
    url.searchParams.set("scope", this.config.scopes);
    url.searchParams.set("state", params.state);
    url.searchParams.set("nonce", params.nonce);
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<TokenResponse> {
    const doc = await this.discover();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.callbackUrl,
      code_verifier: codeVerifier,
      client_id: this.config.clientId,
    });
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };
    if (this.config.clientSecret) {
      const id = encodeURIComponent(this.config.clientId);
      const secret = encodeURIComponent(this.config.clientSecret);
      headers.authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
    }
    const res = await this.fetchFn(doc.token_endpoint, { method: "POST", headers, body });
    if (!res.ok) throw new Error(`OIDC token exchange failed (${res.status})`);
    return (await res.json()) as TokenResponse;
  }

  async userinfo(accessToken: string): Promise<Claims | null> {
    const doc = await this.discover();
    if (!doc.userinfo_endpoint) return null;
    const res = await this.fetchFn(doc.userinfo_endpoint, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as Claims;
  }
}

/** Decode a JWT's payload without verifying its signature. */
export function decodeJwtPayload(jwt: string): Claims {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Malformed ID token");
  const json = Buffer.from(parts[1], "base64url").toString("utf8");
  const payload: unknown = JSON.parse(json);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Malformed ID token payload");
  }
  return payload as Claims;
}

/** Validate ID-token claims. Returns an error message, or null when valid. */
export function validateIdTokenClaims(
  claims: Claims,
  expected: { issuer: string; clientId: string; nonce: string; nowSec: number },
): string | null {
  const skew = 60;
  if (claims.iss !== expected.issuer) return "issuer mismatch";

  const aud = claims.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(expected.clientId)) return "audience mismatch";
  if (audiences.length > 1 && claims.azp !== expected.clientId) return "authorized party mismatch";
  if (claims.azp !== undefined && claims.azp !== expected.clientId) return "authorized party mismatch";

  if (typeof claims.exp !== "number" || claims.exp + skew < expected.nowSec) return "token expired";
  if (typeof claims.iat === "number" && claims.iat - skew > expected.nowSec) return "token issued in the future";
  if (claims.nonce !== expected.nonce) return "nonce mismatch";
  if (typeof claims.sub !== "string" || claims.sub === "") return "missing subject";
  return null;
}

/** Read a claim that may hold a list of group names. */
export function groupsFromClaims(claims: Claims | null | undefined): string[] | null {
  const groups = claims?.groups;
  if (!Array.isArray(groups)) return null;
  return groups.filter((g): g is string => typeof g === "string");
}

/** Only loopback http redirect URIs are accepted (RFC 8252 native-app flow). */
export function isLoopbackRedirect(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (url.username || url.password) return false;
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
}
