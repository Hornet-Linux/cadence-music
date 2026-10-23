import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// The web player keeps its Cadence session in an HttpOnly cookie, so script
// on the page (an injected one included) can't read the token. The desktop
// and phone apps keep using bearer tokens.
//
// CSRF: the cookie is SameSite=Strict and scoped to /api, and any request
// authenticated by the cookie that changes something must carry
// X-Cadence-CSRF, a custom header other sites can't send (the server's CORS
// preflight doesn't allow it, and credentials never go with "*").

export const SESSION_COOKIE = "cadence_session";
export const CSRF_HEADER = "x-cadence-csrf";
/** Sent by the web player on sign-in to get a cookie instead of a token in the body. */
export const COOKIE_MODE_HEADER = "x-cadence-session";
/** Matches the session idle limit; the server ends idle sessions anyway. */
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

/** Routes whose reply is an AuthResponse ({ token, user }). */
const SIGN_IN_ROUTES = new Set(["/api/auth/login", "/api/auth/register", "/api/setup/admin", "/api/auth/exchange", "/api/auth/web-session"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function cookieValue(req: FastifyRequest, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) {
      const value = part.slice(i + 1).trim();
      return /^[\w-]{20,200}$/.test(value) ? value : null;
    }
  }
  return null;
}

export interface SessionCredential {
  token: string;
  via: "bearer" | "cookie";
}

/** The session token a request carries: a bearer token, else the web player's cookie. */
export function sessionCredential(req: FastifyRequest): SessionCredential | null {
  const header = req.headers.authorization ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (bearer) return { token: bearer, via: "bearer" };
  const cookie = cookieValue(req, SESSION_COOKIE);
  return cookie ? { token: cookie, via: "cookie" } : null;
}

/** A cookie-authenticated request that changes something must prove it came from the page. */
export function csrfOk(req: FastifyRequest, credential: SessionCredential): boolean {
  return credential.via === "bearer" || SAFE_METHODS.has(req.method) || req.headers[CSRF_HEADER] === "1";
}

function cookie(req: FastifyRequest, value: string, maxAge: number): string {
  const secure = req.protocol === "https" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

export function clearSessionCookie(req: FastifyRequest, reply: FastifyReply): void {
  reply.header("set-cookie", cookie(req, "", 0));
}

/**
 * When the web player signs in with X-Cadence-Session: cookie, move the token
 * from the reply body into the cookie (the body gets an empty token).
 */
export function registerWebSessionCookies(app: FastifyInstance): void {
  app.addHook("onSend", async (req, reply, payload) => {
    const path = req.url.split("?")[0]!;
    if (req.headers[COOKIE_MODE_HEADER] !== "cookie" || !SIGN_IN_ROUTES.has(path) || reply.statusCode !== 200) return payload;
    if (typeof payload !== "string") return payload;
    let body: { token?: unknown };
    try {
      body = JSON.parse(payload) as { token?: unknown };
    } catch {
      return payload;
    }
    if (typeof body.token !== "string" || !body.token) return payload;
    reply.header("set-cookie", cookie(req, body.token, COOKIE_MAX_AGE_S));
    return JSON.stringify({ ...body, token: "" });
  });
}
