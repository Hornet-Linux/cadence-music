import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  AuthResponse,
  ExchangeRequest,
  HealthResponse,
  LoginRequest,
  PublicUser,
  RegisterRequest,
  SetupAdminRequest,
} from "@uma/shared";
import { registerSignupPage } from "../web/signupPage.js";
import type { Settings } from "../settings.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import type { PreHandler } from "../plugins/types.js";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";
import { pkceChallenge, randomToken, safeEqual } from "../util/crypto.js";
import {
  decodeJwtPayload,
  groupsFromClaims,
  isLoopbackRedirect,
  validateIdTokenClaims,
  type Claims,
} from "./oidc.js";
import type { ActiveOidc } from "./oidcSettings.js";
import { MAX_PASSWORD, checkPassword } from "./passwords.js";
import { RateLimiter } from "./rateLimit.js";
import { registerAccountRoutes } from "./account.js";
import { createSession, deleteSession, userForToken } from "./sessions.js";
import { clearSessionCookie, sessionCredential } from "./webSession.js";
import { recordSecurityEvent } from "../admin/audit.js";
import {
  countPasswordUsers,
  countUsers,
  createLocalUser,
  findUserById,
  findUserByUsername,
  isUniqueViolation,
  toPublicUser,
  upsertOidcUser,
} from "./users.js";

interface PendingLogin {
  redirectUri: string;
  appState: string;
  appChallenge: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
  /** The provider that started this sign-in (settings may change meanwhile). */
  provider: ActiveOidc;
}

interface Handoff {
  userId: number;
  appChallenge: string;
  expiresAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const HANDOFF_TTL_MS = 2 * 60 * 1000;
const MAX_PENDING = 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
/** Failures per account across all addresses, against distributed guessing. */
const USER_MAX_FAILURES = 30;

const USERNAME_RE = /^[\w.@-]{1,48}$/;
const MIN_PASSWORD = 10;
const MAX_SIGNUPS_PER_HOUR = 5;
/** Every sign-up attempt counts, so usernames can't be probed (username_taken) without limit. */
const MAX_SIGNUP_ATTEMPTS_PER_HOUR = 20;
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
/**
 * A device that signed in to an account recently (same address, a session used
 * in this window) isn't held back by that account's lockout, so a stranger
 * hammering a known username can't lock its owner out.
 */
const KNOWN_DEVICE_MS = 30 * 24 * 60 * 60 * 1000;
/** Invite codes an admin sets: long enough not to be guessed within the rate limits. */
export const MIN_INVITE_CODE = 12;

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const STATE_RE = /^[A-Za-z0-9._~-]{8,256}$/;

function purge<T extends { expiresAt: number }>(map: Map<string, T>): void {
  const now = Date.now();
  for (const [key, value] of map) if (value.expiresAt <= now) map.delete(key);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function errorPage(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title>
<body style="font-family:system-ui;background:#0b0b0f;color:#f4f4f8;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:420px;text-align:center"><h1 style="font-size:1.3rem">Sign-in failed</h1>
<p style="color:#9a9ab0">${escapeHtml(message)}</p></div></body>`;
}

function withParams(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: {
    db: Db;
    config: Config;
    settings: Settings;
    /** The single sign-on provider in effect right now (env or admin panel), if any. */
    oidc: () => ActiveOidc | null;
    requireUser: PreHandler;
    /** Receives the first-run setup code; defaults to logging it. */
    onSetupCode?: (code: string) => void;
  },
): void {
  const { db, config, oidc, requireUser, settings } = deps;
  const oidcName = () => {
    const p = oidc();
    return p ? { name: p.config.displayName } : null;
  };
  const pending = new Map<string, PendingLogin>();
  const handoffs = new Map<string, Handoff>();
  // Failed sign-in / setup / invite-code attempts per client address.
  const failures = new RateLimiter({ max: LOGIN_MAX_FAILURES, windowMs: LOGIN_WINDOW_MS });
  // Failed sign-ins per (lower-cased) username, whatever the address.
  const userFailures = new RateLimiter({ max: USER_MAX_FAILURES, windowMs: LOGIN_WINDOW_MS });
  const signups = new RateLimiter({ max: MAX_SIGNUPS_PER_HOUR, windowMs: SIGNUP_WINDOW_MS });
  const signupAttempts = new RateLimiter({ max: MAX_SIGNUP_ATTEMPTS_PER_HOUR, windowMs: SIGNUP_WINDOW_MS });

  const invite = settings.signup();
  if (invite?.mode === "invite" && invite.inviteCode.length < MIN_INVITE_CODE) {
    app.log.warn(`The sign-up invite code is shorter than ${MIN_INVITE_CODE} characters; set a longer one in the admin panel`);
  }

  /** Has this address used a session of this account recently? */
  function knownDevice(userId: number, ip: string): boolean {
    return !!db
      .prepare("SELECT 1 FROM sessions WHERE user_id = ? AND ip = ? AND last_used_at > ? LIMIT 1")
      .get(userId, ip.slice(0, 64), Date.now() - KNOWN_DEVICE_MS);
  }

  function respond(userId: number, req: FastifyRequest): AuthResponse {
    const token = createSession(db, userId, { userAgent: req.headers["user-agent"], ip: req.ip });
    return { token, user: toPublicUser(findUserById(db, userId)!) };
  }

  // ---- First-run setup --------------------------------------------------
  // A brand-new server (no accounts) prints a one-time code to its logs. The
  // first admin is created by presenting it, so nobody who merely finds the
  // server before its owner can claim it.
  let setupCode: string | null = countUsers(db) === 0 ? randomToken(18) : null;
  const setupRequired = () => {
    if (setupCode && countUsers(db) > 0) setupCode = null;
    return setupCode !== null;
  };
  if (setupCode) {
    const code = setupCode;
    app.addHook("onReady", async () => {
      if (deps.onSetupCode) deps.onSetupCode(code);
      else app.log.warn(`First-run setup code: ${code} — enter it in the app to create the admin account`);
    });
  }

  app.get("/api/health", async (): Promise<HealthResponse> => ({
    ok: true,
    name: SERVER_NAME,
    version: SERVER_VERSION,
    setupRequired: setupRequired(),
    auth: {
      password: countPasswordUsers(db) > 0,
      oidc: oidcName(),
      signup: setupRequired() ? "closed" : (settings.signup()?.mode ?? "closed"),
    },
  }));

  // ---- Self-service sign-up ----------------------------------------------
  // Off unless the owner enables it (SIGNUP_MODE=open|invite), and never
  // before the owner has claimed the server with the setup code.
  app.post<{ Body: RegisterRequest }>("/api/auth/register", async (req, reply) => {
    const signup = settings.signup();
    if (!signup || setupRequired()) return reply.code(403).send({ error: "signup_closed" });

    if (signups.isLimited(req.ip) || signupAttempts.isLimited(req.ip)) {
      return reply.code(429).send({ error: "too_many_attempts", message: "Try again later." });
    }
    signupAttempts.hit(req.ip);

    const body = (req.body ?? {}) as Partial<RegisterRequest>;
    if (signup.mode === "invite") {
      // Wrong codes share the failure budget with sign-in, so codes can't be guessed freely.
      if (failures.isLimited(req.ip)) {
        return reply.code(429).send({ error: "too_many_attempts", message: "Try again later." });
      }
      if (typeof body.inviteCode !== "string" || !safeEqual(body.inviteCode.trim(), signup.inviteCode)) {
        failures.hit(req.ip);
        return reply.code(403).send({ error: "invalid_invite_code" });
      }
    }
    const username = typeof body.username === "string" ? body.username.trim() : "";
    if (!USERNAME_RE.test(username)) return reply.code(400).send({ error: "invalid_username" });
    if (
      typeof body.password !== "string" ||
      body.password.length < MIN_PASSWORD ||
      body.password.length > MAX_PASSWORD
    ) {
      return reply.code(400).send({ error: "weak_password" });
    }
    if (findUserByUsername(db, username)) return reply.code(409).send({ error: "username_taken" });

    const displayName =
      typeof body.displayName === "string" && body.displayName.trim()
        ? body.displayName.trim().slice(0, 80)
        : undefined;
    let user;
    try {
      user = await createLocalUser(db, { username, password: body.password, displayName });
    } catch (err) {
      // Someone else took the name while the password was being hashed.
      if (isUniqueViolation(err)) return reply.code(409).send({ error: "username_taken" });
      throw err;
    }
    signups.hit(req.ip);
    return respond(user.id, req);
  });

  registerSignupPage(app, {
    config,
    signup: () => settings.signup(),
    signupOpen: () => !!settings.signup() && !setupRequired(),
  });

  app.post<{ Body: SetupAdminRequest }>("/api/setup/admin", async (req, reply) => {
    if (!setupRequired()) return reply.code(409).send({ error: "already_set_up" });
    if (failures.isLimited(req.ip)) {
      return reply.code(429).send({ error: "too_many_attempts", message: "Try again later." });
    }
    const { setupCode: code, username, password } = (req.body ?? {}) as Partial<SetupAdminRequest>;
    if (typeof code !== "string" || !safeEqual(code.trim(), setupCode!)) {
      failures.hit(req.ip);
      return reply.code(403).send({ error: "invalid_setup_code" });
    }
    if (typeof username !== "string" || !USERNAME_RE.test(username.trim())) {
      return reply.code(400).send({ error: "invalid_username" });
    }
    if (typeof password !== "string" || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
      return reply.code(400).send({ error: "weak_password" });
    }
    // Claim the code before hashing (which awaits) so two concurrent requests
    // with the right code can't both create an admin.
    const claimed = setupCode!;
    setupCode = null;
    try {
      const user = await createLocalUser(db, { username: username.trim(), password, isAdmin: true });
      return respond(user.id, req);
    } catch (err) {
      setupCode = claimed;
      throw err;
    }
  });

  // ---- Password sign-in -------------------------------------------------
  app.post<{ Body: LoginRequest }>("/api/auth/login", async (req, reply) => {
    const ip = req.ip;
    if (failures.isLimited(ip)) {
      return reply.code(429).send({ error: "too_many_attempts", message: "Try again later." });
    }

    const { username, password } = (req.body ?? {}) as Partial<LoginRequest>;
    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    if (password.length > MAX_PASSWORD) return reply.code(400).send({ error: "invalid_request" });

    // Bounded key: real usernames are at most 48 characters.
    const userKey = username.toLowerCase().slice(0, 128);
    const user = findUserByUsername(db, username);
    if (userFailures.isLimited(userKey) && !(user && knownDevice(user.id, ip))) {
      return reply.code(429).send({ error: "too_many_attempts", message: "Try again later." });
    }

    // Always does the full hash work, even for unknown names and SSO-only accounts.
    const ok = await checkPassword(password, user?.password_hash);
    if (!ok || !user) {
      const ipWasLimited = failures.isLimited(ip);
      const userWasLimited = userFailures.isLimited(userKey);
      failures.hit(ip);
      userFailures.hit(userKey);
      // Lockouts go to the admin's activity log (once each, when they start).
      if (!ipWasLimited && failures.isLimited(ip)) {
        recordSecurityEvent(db, "signin.ip_locked", ip, `${LOGIN_MAX_FAILURES} failed sign-ins from this address`);
      }
      if (user && !userWasLimited && userFailures.isLimited(userKey)) {
        recordSecurityEvent(db, "signin.locked", user.username, `${USER_MAX_FAILURES} failed sign-ins; last from ${ip}`);
      }
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    failures.reset(ip);
    userFailures.reset(userKey);
    // Said only after the password was right, so it doesn't reveal which names exist.
    if (user.disabled_at) return reply.code(403).send({ error: "account_disabled" });
    return respond(user.id, req);
  });

  // ---- OIDC sign-in (desktop loopback / web player + PKCE) ---------------
  // The only non-loopback destination allowed is this server's own web
  // player callback, so the one-time code can't be sent anywhere else.
  const webCallback = config.publicUrl ? `${config.publicUrl}/app/auth/callback` : null;
  app.get<{ Querystring: Record<string, string | undefined> }>(
    "/api/auth/oidc/start",
    async (req, reply) => {
      const provider = oidc();
      if (!provider) return reply.code(404).send({ error: "oidc_not_configured" });
      const { redirect_uri: redirectUri, state, code_challenge: challenge } = req.query;
      if (!redirectUri || !(isLoopbackRedirect(redirectUri) || redirectUri === webCallback)) {
        return reply.code(400).send({ error: "invalid_redirect_uri" });
      }
      if (!state || !STATE_RE.test(state)) return reply.code(400).send({ error: "invalid_state" });
      if (!challenge || !CHALLENGE_RE.test(challenge)) {
        return reply.code(400).send({ error: "invalid_code_challenge" });
      }

      purge(pending);
      if (pending.size >= MAX_PENDING) return reply.code(429).send({ error: "too_many_pending" });

      const serverState = randomToken(24);
      const nonce = randomToken(24);
      const verifier = randomToken(48);
      pending.set(serverState, {
        redirectUri,
        appState: state,
        appChallenge: challenge,
        nonce,
        verifier,
        expiresAt: Date.now() + PENDING_TTL_MS,
        provider,
      });

      try {
        const url = await provider.client.authorizationUrl({
          state: serverState,
          nonce,
          codeChallenge: pkceChallenge(verifier),
        });
        return reply.redirect(url);
      } catch (err) {
        pending.delete(serverState);
        req.log.error({ err }, "OIDC start failed");
        return reply.code(502).send({ error: "oidc_unavailable" });
      }
    },
  );

  app.get<{ Querystring: Record<string, string | undefined> }>(
    "/api/auth/oidc/callback",
    async (req, reply) => {
      const { code, state, error } = req.query;
      const login = state ? pending.get(state) : undefined;
      if (state) pending.delete(state);

      if (!login || login.expiresAt <= Date.now()) {
        return reply
          .code(400)
          .type("text/html")
          .send(errorPage("This sign-in link has expired. Start again from the app."));
      }

      const fail = (reason: string) =>
        reply.redirect(withParams(login.redirectUri, { error: reason, state: login.appState }));

      if (error || !code) return fail(error ?? "missing_code");
      const { client, config: oidcConfig } = login.provider;

      let tokens;
      try {
        tokens = await client.exchangeCode(code, login.verifier);
      } catch (err) {
        // Usually a wrong client secret or redirect URI at the provider.
        req.log.error({ err }, "OIDC token exchange failed");
        return fail("token_exchange_failed");
      }

      try {
        if (!tokens.id_token) return fail("missing_id_token");
        const claims = decodeJwtPayload(tokens.id_token);
        const doc = await client.discover();
        const problem = validateIdTokenClaims(claims, {
          issuer: doc.issuer,
          clientId: oidcConfig.clientId,
          nonce: login.nonce,
          nowSec: Math.floor(Date.now() / 1000),
        });
        if (problem) {
          req.log.warn({ problem }, "OIDC ID token rejected");
          return fail("invalid_id_token");
        }

        let profile: Claims = claims;
        let groups = groupsFromClaims(claims);
        const needGroups =
          oidcConfig.allowedGroups.length > 0 || oidcConfig.adminGroups.length > 0;
        if ((needGroups && groups === null) || !claims.email) {
          const info = tokens.access_token ? await client.userinfo(tokens.access_token) : null;
          if (info && info.sub === claims.sub) {
            profile = { ...info, ...claims };
            groups = groups ?? groupsFromClaims(info);
          }
        }

        const allowed = oidcConfig.allowedGroups;
        if (allowed.length > 0 && !(groups ?? []).some((g) => allowed.includes(g))) {
          return fail("access_denied");
        }
        const adminGroups = oidcConfig.adminGroups;
        const user = upsertOidcUser(db, {
          issuer: doc.issuer,
          subject: claims.sub as string,
          preferredUsername:
            typeof profile.preferred_username === "string" ? profile.preferred_username : undefined,
          email: typeof profile.email === "string" ? profile.email : undefined,
          name: typeof profile.name === "string" ? profile.name : undefined,
          isAdmin:
            adminGroups.length > 0 ? (groups ?? []).some((g) => adminGroups.includes(g)) : undefined,
        });

        if (user.disabled_at) return fail("account_disabled");

        purge(handoffs);
        // Hard cap like `pending`: drop the oldest rather than grow without bound.
        for (const key of handoffs.keys()) {
          if (handoffs.size < MAX_PENDING) break;
          handoffs.delete(key);
        }
        const handoffCode = randomToken(32);
        handoffs.set(handoffCode, {
          userId: user.id,
          appChallenge: login.appChallenge,
          expiresAt: Date.now() + HANDOFF_TTL_MS,
        });
        return reply.redirect(
          withParams(login.redirectUri, { code: handoffCode, state: login.appState }),
        );
      } catch (err) {
        req.log.error({ err }, "OIDC callback failed");
        return fail("server_error");
      }
    },
  );

  app.post<{ Body: ExchangeRequest }>("/api/auth/exchange", async (req, reply) => {
    const { code, code_verifier: verifier } = (req.body ?? {}) as Partial<ExchangeRequest>;
    if (typeof code !== "string" || typeof verifier !== "string") {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const handoff = handoffs.get(code);
    handoffs.delete(code); // single use, even on failure
    if (!handoff || handoff.expiresAt <= Date.now()) {
      return reply.code(400).send({ error: "invalid_code" });
    }
    if (!safeEqual(pkceChallenge(verifier), handoff.appChallenge)) {
      return reply.code(400).send({ error: "invalid_code_verifier" });
    }
    const holder = findUserById(db, handoff.userId);
    if (!holder || holder.disabled_at) return reply.code(403).send({ error: "account_disabled" });
    return respond(handoff.userId, req);
  });

  // ---- Session ----------------------------------------------------------
  app.post("/api/auth/logout", { preHandler: requireUser }, async (req, reply) => {
    const credential = sessionCredential(req)!;
    deleteSession(db, credential.token);
    if (credential.via === "cookie") clearSessionCookie(req, reply);
    return reply.code(204).send();
  });

  // Who is signed in, if anyone. Always 200, so the web player can check its
  // cookie on start without a 401 in the console for a signed-out visitor.
  app.get("/api/auth/session", async (req): Promise<{ user: PublicUser | null }> => {
    const credential = sessionCredential(req);
    const user = credential ? userForToken(db, credential.token) : null;
    return { user: user && !user.disabled_at ? toPublicUser(user) : null };
  });

  // The web player moves a session it used to keep in localStorage into the
  // HttpOnly cookie (sent with X-Cadence-Session: cookie, which the cookie hook
  // turns into Set-Cookie). Same session, so nothing else changes.
  app.post("/api/auth/web-session", { preHandler: requireUser }, async (req, reply) => {
    const credential = sessionCredential(req)!;
    if (credential.via !== "bearer") return reply.code(400).send({ error: "already_cookie" });
    return { token: credential.token, user: toPublicUser(req.user!) } satisfies AuthResponse;
  });

  app.get("/api/me", { preHandler: requireUser }, async (req): Promise<PublicUser> =>
    toPublicUser(req.user!),
  );

  registerAccountRoutes(app, { db, config, requireUser });
}
