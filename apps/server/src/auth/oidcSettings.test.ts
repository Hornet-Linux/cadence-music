import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { makeAdminPlugin } from "../admin/plugin.js";
import { buildApp } from "../app.js";
import type { Config } from "../config.js";
import { loadConfig } from "../config.js";
import { openDb, type Db } from "../db.js";
import { pkceChallenge, randomToken } from "../util/crypto.js";
import type { FetchFn } from "./oidc.js";
import {
  applyOidcInput,
  effectiveOidc,
  oidcResolver,
  openSecret,
  readStoredOidc,
  sealSecret,
  testDiscovery,
  writeStoredOidc,
} from "./oidcSettings.js";
import { createLocalUser, findUserByUsername } from "./users.js";

const SECRET = "k".repeat(64);
const ISSUER = "https://kc.test/realms/home";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function baseConfig(dir: string, extra: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    musicDir: dir,
    scanIntervalMinutes: 0,
    trustProxy: false,
    logLevel: "silent",
    publicUrl: "https://music.test",
    oidcEnv: {},
    ...extra,
  };
}

// ---- Unit -------------------------------------------------------------------------

test("client secrets are sealed with the server secret", () => {
  const sealed = sealSecret(SECRET, "hush");
  assert.ok(!sealed.includes("hush"));
  assert.equal(openSecret(SECRET, sealed), "hush");
  assert.equal(openSecret("other".repeat(10), sealed), null, "another server secret can't open it");
  assert.equal(openSecret(SECRET, "v1.garbage"), null);
});

test("loadConfig records which OIDC values came from the environment", () => {
  const c = loadConfig({ PUBLIC_URL: "https://m.test", OIDC_CLIENT_SECRET: "env-secret", OIDC_ADMIN_GROUPS: "a, b" });
  assert.equal(c.oidc, undefined);
  assert.deepEqual(c.oidcEnv, { clientSecret: "env-secret", adminGroups: ["a", "b"] });
  assert.deepEqual(loadConfig({}).oidcEnv, {});
});

test("environment values win field by field over saved ones", () => {
  const db = openDb(":memory:");
  const config = baseConfig("/tmp", { oidcEnv: { clientId: "from-env", allowedGroups: ["env-group"] } });
  writeStoredOidc(db, {
    issuer: ISSUER,
    clientId: "saved-id",
    clientSecretSealed: sealSecret(SECRET, "saved-secret"),
    allowedGroups: ["saved-group"],
    adminGroups: ["saved-admins"],
  });
  const eff = effectiveOidc(config, db, SECRET);
  assert.equal(eff.config?.issuer, ISSUER);
  assert.equal(eff.config?.clientId, "from-env");
  assert.equal(eff.config?.clientSecret, "saved-secret");
  assert.deepEqual(eff.config?.allowedGroups, ["env-group"]);
  assert.deepEqual(eff.config?.adminGroups, ["saved-admins"]);
  assert.equal(eff.config?.displayName, "Single sign-on");
  assert.equal(eff.source.clientId, "env");
  assert.equal(eff.source.issuer, "admin");
  assert.equal(eff.source.displayName, "default");
  assert.equal(effectiveOidc(config, db, "x".repeat(40)).secretUnreadable, true);
  db.close();
});

test("admin input is validated and locked fields are left alone", () => {
  const locked = { clientId: true };
  const ok = applyOidcInput(
    { issuer: ` ${ISSUER} `, clientId: "ignored", clientSecret: "s3", allowedGroups: "a, b,, a", scopes: "openid email" },
    {},
    locked,
    SECRET,
  );
  assert.ok("stored" in ok);
  assert.equal(ok.stored.issuer, ISSUER);
  assert.equal(ok.stored.clientId, undefined);
  assert.deepEqual(ok.stored.allowedGroups, ["a", "b"]);
  assert.equal(openSecret(SECRET, ok.stored.clientSecretSealed!), "s3");

  // "" keeps the saved secret, null removes it.
  assert.equal((applyOidcInput({ clientSecret: "" }, ok.stored, {}, SECRET) as { stored: { clientSecretSealed?: string } }).stored.clientSecretSealed, ok.stored.clientSecretSealed);
  assert.equal((applyOidcInput({ clientSecret: null }, ok.stored, {}, SECRET) as { stored: { clientSecretSealed?: string } }).stored.clientSecretSealed, undefined);

  const bad = (input: object) => (applyOidcInput(input, {}, {}, SECRET) as { error?: string }).error;
  assert.equal(bad({ issuer: "ftp://x" }), "invalid_issuer");
  assert.equal(bad({ issuer: "https://u:p@x.test" }), "invalid_issuer");
  assert.equal(bad({ clientId: "has space" }), "invalid_clientId");
  assert.equal(bad({ scopes: "profile email" }), "scopes_need_openid");
  assert.equal(bad({ adminGroups: [1] }), "invalid_adminGroups");
  assert.equal(bad({ clientSecret: 5 }), "invalid_clientSecret");
});

test("the resolver rebuilds the client only when the settings change", () => {
  const db = openDb(":memory:");
  const resolve = oidcResolver(baseConfig("/tmp"), db, SECRET);
  assert.equal(resolve(), null);
  writeStoredOidc(db, { issuer: ISSUER, clientId: "a" });
  const first = resolve();
  assert.equal(first?.config.clientId, "a");
  assert.equal(resolve(), first, "same settings, same client (keeps its discovery cache)");
  writeStoredOidc(db, { issuer: ISSUER, clientId: "b" });
  assert.equal(resolve()?.config.clientId, "b");
  writeStoredOidc(db, null);
  assert.equal(resolve(), null);
  assert.deepEqual(readStoredOidc(db), {});
  db.close();
});

test("test connection reports a down provider and a mismatched issuer plainly", async () => {
  const down = (async () => {
    throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  }) as unknown as FetchFn;
  assert.deepEqual(await testDiscovery(ISSUER, down), { ok: false, error: "fetch failed (ECONNREFUSED)" });
  const other = (async () => json({ issuer: "https://elsewhere.test", authorization_endpoint: "a", token_endpoint: "t" })) as unknown as FetchFn;
  const r = await testDiscovery(ISSUER, other);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /does not match/);
  const slow = ((_u: string, init?: RequestInit) =>
    new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as FetchFn;
  const keepAlive = setTimeout(() => undefined, 1000); // the abort timer alone doesn't hold the event loop open
  assert.deepEqual(await testDiscovery(ISSUER, slow, 50), { ok: false, error: "The provider didn't answer in time." });
  clearTimeout(keepAlive);
  assert.equal((await testDiscovery("not a url")).ok, false);
});

// ---- Through the app ----------------------------------------------------------

function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(claims)}.sig`;
}

/** A fake provider that checks the client secret and PKCE like a real one. */
function fakeProvider(opts: { secret: string; groups: string[] }) {
  const seen = { nonce: "", challenge: "", up: true };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!seen.up) throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/auth`, token_endpoint: `${ISSUER}/token` });
    }
    if (url === `${ISSUER}/token`) {
      const auth = (init?.headers as Record<string, string>).authorization;
      if (auth !== `Basic ${Buffer.from(`cadence:${opts.secret}`).toString("base64")}`) return json({ error: "unauthorized_client" }, 401);
      const body = new URLSearchParams(String(init?.body));
      if (pkceChallenge(body.get("code_verifier") ?? "") !== seen.challenge) return json({ error: "invalid_grant" }, 400);
      const now = Math.floor(Date.now() / 1000);
      return json({
        id_token: jwt({ iss: ISSUER, aud: "cadence", azp: "cadence", sub: "kc-1", nonce: seen.nonce, exp: now + 60, iat: now, preferred_username: "kira", email: "kira@test", groups: opts.groups }),
      });
    }
    return json({}, 404);
  }) as unknown as FetchFn;
  return { fetchFn, seen };
}

async function appWith(fetchFn: FetchFn, extra: Partial<Config> = {}): Promise<{ app: FastifyInstance; db: Db; admin: (m: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: object) => Promise<Awaited<ReturnType<FastifyInstance["inject"]>>>; close: () => Promise<void> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-oidc-"));
  const db = openDb(":memory:");
  await createLocalUser(db, { username: "owner", password: "owner-password", isAdmin: true });
  const app = await buildApp({ config: baseConfig(dir, extra), db, secret: SECRET, logger: false, fetchFn, onSetupCode: () => undefined, plugins: [makeAdminPlugin({ fetchFn })] });
  const token = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "owner", password: "owner-password" } })).json().token as string;
  const admin = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  return { app, db, admin, close: async () => { await app.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

async function signIn(app: FastifyInstance, seen: { nonce: string; challenge: string }): Promise<{ start: number; back?: URL; verifier: string }> {
  const verifier = randomToken(32);
  const start = await app.inject({
    method: "GET",
    url: `/api/auth/oidc/start?${new URLSearchParams({ redirect_uri: "http://127.0.0.1:5000/cb", state: "st-12345678", code_challenge: pkceChallenge(verifier) })}`,
  });
  if (start.statusCode !== 302) return { start: start.statusCode, verifier };
  const auth = new URL(start.headers.location as string);
  seen.nonce = auth.searchParams.get("nonce")!;
  seen.challenge = auth.searchParams.get("code_challenge")!;
  const cb = await app.inject({ method: "GET", url: `/api/auth/oidc/callback?code=c&state=${auth.searchParams.get("state")}` });
  return { start: 302, back: new URL(cb.headers.location as string), verifier };
}

test("single sign-on set up on the admin page works at once, without a restart", async () => {
  const idp = fakeProvider({ secret: "right-secret", groups: ["music", "music-admins"] });
  const { app, db, admin, close } = await appWith(idp.fetchFn);
  assert.equal((await app.inject({ method: "GET", url: "/api/health" })).json().auth.oidc, null);
  assert.equal((await signIn(app, idp.seen)).start, 404);

  const saved = await admin("PUT", "/api/admin/sso", {
    issuer: ISSUER, clientId: "cadence", clientSecret: "right-secret", displayName: "Keycloak", allowedGroups: "music", adminGroups: "music-admins",
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().active, true);
  assert.equal(saved.json().hasClientSecret, true);
  assert.ok(!saved.body.includes("right-secret"), "the secret is never sent back");
  const row = db.prepare("SELECT value FROM settings WHERE key = 'oidc'").get() as { value: string };
  assert.ok(!row.value.includes("right-secret"), "the secret is stored sealed");
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/health" })).json().auth.oidc, { name: "Keycloak" });

  const ok = await signIn(app, idp.seen);
  assert.ok(ok.back?.searchParams.get("code"), ok.back?.href ?? "sign-in redirect was missing");
  const ex = await app.inject({ method: "POST", url: "/api/auth/exchange", payload: { code: ok.back!.searchParams.get("code"), code_verifier: ok.verifier } });
  assert.equal(ex.statusCode, 200, ex.body);
  assert.equal(findUserByUsername(db, "kira")?.is_admin, 1, "admin group promotes");

  // A wrong secret now shows up as a clear error, not a generic one.
  await admin("PUT", "/api/admin/sso", { clientSecret: "wrong" });
  assert.equal((await signIn(app, idp.seen)).back?.searchParams.get("error"), "token_exchange_failed");

  // Leaving the admin group demotes on the next sign-in.
  await admin("PUT", "/api/admin/sso", { clientSecret: "right-secret", adminGroups: "" });
  await admin("PUT", "/api/admin/sso", { adminGroups: "other-admins" });
  assert.ok((await signIn(app, idp.seen)).back?.searchParams.get("code"));
  assert.equal(findUserByUsername(db, "kira")?.is_admin, 0);

  // Not in an allowed group.
  await admin("PUT", "/api/admin/sso", { allowedGroups: "vip" });
  assert.equal((await signIn(app, idp.seen)).back?.searchParams.get("error"), "access_denied");

  // Provider down: start answers 502, the page and the test say why.
  idp.seen.up = false;
  await admin("PUT", "/api/admin/sso", { displayName: "Keycloak 2" }); // new client, no cached discovery
  assert.equal((await signIn(app, idp.seen)).start, 502);
  const view = (await admin("GET", "/api/admin/sso")).json();
  assert.equal(view.discovery.ok, false);
  assert.match(view.discovery.error, /ECONNREFUSED/);
  assert.equal((await admin("POST", "/api/admin/sso/test", {})).json().ok, false);

  // Removing the saved settings turns it off again.
  assert.equal((await admin("DELETE", "/api/admin/sso")).json().configured, false);
  assert.equal((await app.inject({ method: "GET", url: "/api/health" })).json().auth.oidc, null);
  await close();
});

test("environment values are locked on the admin page and a bad PUT is refused", async () => {
  const idp = fakeProvider({ secret: "env-secret", groups: [] });
  const { admin, close } = await appWith(idp.fetchFn, {
    oidcEnv: { issuer: ISSUER, clientId: "cadence", clientSecret: "env-secret" },
    oidc: { issuer: ISSUER, clientId: "cadence", clientSecret: "env-secret", displayName: "Single sign-on", scopes: "openid profile email", allowedGroups: [], adminGroups: [] },
  });
  const put = await admin("PUT", "/api/admin/sso", { issuer: "https://other.test", clientId: "x", displayName: "Home" });
  assert.equal(put.statusCode, 200);
  const v = put.json();
  assert.equal(v.issuer, ISSUER);
  assert.equal(v.clientId, "cadence");
  assert.equal(v.name, "Home", "unlocked fields can still be changed");
  assert.equal(v.locked.issuer, true);
  assert.equal(v.locked.displayName, false);
  assert.equal(v.source.clientSecret, "env");
  assert.equal((await admin("PUT", "/api/admin/sso", { scopes: "email" })).json().error, "scopes_need_openid");
  assert.equal((await admin("PUT", "/api/admin/sso", { allowedGroups: 7 })).statusCode, 400);
  await close();
});
