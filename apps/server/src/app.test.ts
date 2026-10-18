import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AuthResponse, StreamUrlResponse, TrackListResponse } from "@uma/shared";
import { buildApp } from "./app.js";
import type { Config } from "./config.js";
import { openDb, type Db } from "./db.js";
import { createLocalUser } from "./auth/users.js";
import type { FetchFn } from "./auth/oidc.js";
import { pkceChallenge, randomToken } from "./util/crypto.js";

const SECRET = "s".repeat(64);
const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-test-"));
  tempDirs.push(dir);
  return dir;
}

function testConfig(musicDir: string, overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir: musicDir,
    musicDir,
    scanIntervalMinutes: 0,
    trustProxy: false,
    logLevel: "silent",
    ...overrides,
  };
}

/** A minimal valid 8 kHz mono 8-bit PCM WAV file. */
function wav(samples: number): Buffer {
  const buf = Buffer.alloc(44 + samples);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(8000, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples, 40);
  buf.fill(128, 44);
  return buf;
}

async function setup(
  overrides: Partial<Config> = {},
  fetchFn?: FetchFn,
): Promise<{ app: FastifyInstance; db: Db; musicDir: string }> {
  const musicDir = tempDir();
  const db = openDb(":memory:");
  createLocalUser(db, { username: "admin", password: "admin-password", isAdmin: true });
  createLocalUser(db, { username: "listener", password: "listener-password" });
  const app = await buildApp({
    config: testConfig(musicDir, overrides),
    db,
    secret: SECRET,
    logger: false,
    fetchFn,
  });
  return { app, db, musicDir };
}

async function login(app: FastifyInstance, username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as AuthResponse).token;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test("health reports available sign-in methods", async () => {
  const { app, db } = await setup();
  const res = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().auth, { password: true, oidc: null });
  await app.close();
  db.close();
});

test("password sign-in, session and sign-out", async () => {
  const { app, db } = await setup();

  const bad = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "admin", password: "nope" },
  });
  assert.equal(bad.statusCode, 401);

  assert.equal((await app.inject({ method: "GET", url: "/api/me" })).statusCode, 401);

  const token = await login(app, "admin", "admin-password");
  const me = await app.inject({ method: "GET", url: "/api/me", headers: bearer(token) });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().username, "admin");
  assert.equal(me.json().isAdmin, true);

  const out = await app.inject({ method: "POST", url: "/api/auth/logout", headers: bearer(token) });
  assert.equal(out.statusCode, 204);
  const afterLogout = await app.inject({ method: "GET", url: "/api/me", headers: bearer(token) });
  assert.equal(afterLogout.statusCode, 401);

  await app.close();
  db.close();
});

test("rate-limits repeated failed sign-ins", async () => {
  const { app, db } = await setup();
  for (let i = 0; i < 10; i++) {
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "wrong" },
    });
  }
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "admin", password: "admin-password" },
  });
  assert.equal(res.statusCode, 429);
  await app.close();
  db.close();
});

test("scans the library and streams with byte ranges", async () => {
  const { app, db, musicDir } = await setup();
  fs.writeFileSync(path.join(musicDir, "Test Song.wav"), wav(800));
  fs.mkdirSync(path.join(musicDir, "Artist", "Album"), { recursive: true });
  fs.writeFileSync(path.join(musicDir, "Artist", "Album", "01 Second Track.wav"), wav(400));
  fs.writeFileSync(path.join(musicDir, "notes.txt"), "not audio");

  const admin = await login(app, "admin", "admin-password");
  const listener = await login(app, "listener", "listener-password");

  const forbidden = await app.inject({
    method: "POST",
    url: "/api/library/scan?wait=1",
    headers: bearer(listener),
  });
  assert.equal(forbidden.statusCode, 403);

  const scan = await app.inject({
    method: "POST",
    url: "/api/library/scan?wait=1",
    headers: bearer(admin),
  });
  assert.equal(scan.statusCode, 200, scan.body);
  assert.equal(scan.json().total, 2);

  const list = await app.inject({ method: "GET", url: "/api/tracks", headers: bearer(listener) });
  const tracks = list.json() as TrackListResponse;
  assert.equal(tracks.total, 2);
  const song = tracks.items.find((t) => t.title === "Test Song");
  if (!song) throw new Error("expected a track titled from its filename");

  const search = await app.inject({
    method: "GET",
    url: "/api/tracks?q=Second",
    headers: bearer(listener),
  });
  assert.equal((search.json() as TrackListResponse).total, 1);

  const signed = await app.inject({
    method: "GET",
    url: `/api/tracks/${song.id}/stream-url`,
    headers: bearer(listener),
  });
  assert.equal(signed.statusCode, 200);
  const { path: streamPath } = signed.json() as StreamUrlResponse;

  const ranged = await app.inject({
    method: "GET",
    url: `/${streamPath}`,
    headers: { range: "bytes=0-9" },
  });
  assert.equal(ranged.statusCode, 206);
  assert.equal(ranged.headers["content-range"], "bytes 0-9/844");
  assert.equal(ranged.headers["content-type"], "audio/wav");
  assert.equal(ranged.rawPayload.length, 10);
  assert.equal(ranged.rawPayload.subarray(0, 4).toString(), "RIFF");

  const full = await app.inject({ method: "GET", url: `/${streamPath}` });
  assert.equal(full.statusCode, 200);
  assert.equal(full.rawPayload.length, 844);

  const unsatisfiable = await app.inject({
    method: "GET",
    url: `/${streamPath}`,
    headers: { range: "bytes=5000-" },
  });
  assert.equal(unsatisfiable.statusCode, 416);

  const tampered = await app.inject({
    method: "GET",
    url: `/${streamPath.replace(/sig=[^&]+/, "sig=forged")}`,
  });
  assert.equal(tampered.statusCode, 403);

  // Removing a file drops it on the next scan.
  fs.rmSync(path.join(musicDir, "Test Song.wav"));
  const rescan = await app.inject({
    method: "POST",
    url: "/api/library/scan?wait=1",
    headers: bearer(admin),
  });
  assert.equal(rescan.json().removed, 1);
  assert.equal(rescan.json().total, 1);

  await app.close();
  db.close();
});

// ---- OIDC -----------------------------------------------------------------

const ISSUER = "https://idp.test/application/o/music/";

function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc(claims)}.signature`;
}

/** A fake identity provider that also checks the server's PKCE verifier. */
function fakeIdp(groups: string[]) {
  const state = { nonce: "", challenge: "" };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchFn: FetchFn = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${ISSUER}.well-known/openid-configuration`) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: "https://idp.test/authorize",
        token_endpoint: "https://idp.test/token",
        userinfo_endpoint: "https://idp.test/userinfo",
      });
    }
    if (url === "https://idp.test/token") {
      const body = new URLSearchParams(String(init?.body));
      if (body.get("code") !== "idp-code") return json({ error: "invalid_grant" }, 400);
      if (pkceChallenge(body.get("code_verifier") ?? "") !== state.challenge) {
        return json({ error: "invalid_grant" }, 400);
      }
      const now = Math.floor(Date.now() / 1000);
      return json({
        access_token: "access",
        id_token: jwt({
          iss: ISSUER,
          aud: "music-app",
          sub: "user-123",
          nonce: state.nonce,
          iat: now,
          exp: now + 300,
          preferred_username: "alice",
          email: "alice@example.com",
          name: "Alice",
          groups,
        }),
      });
    }
    return json({ error: "not_found" }, 404);
  };
  return { fetchFn, state };
}

const oidcConfig = (groups: { allowed?: string[]; admin?: string[] } = {}): Partial<Config> => ({
  publicUrl: "https://music.test",
  oidc: {
    issuer: ISSUER,
    clientId: "music-app",
    clientSecret: "client-secret",
    displayName: "Authentik",
    scopes: "openid profile email",
    allowedGroups: groups.allowed ?? [],
    adminGroups: groups.admin ?? [],
  },
});

/** Drive start → IdP → callback; returns where the server sent the browser. */
async function oidcRoundTrip(
  app: FastifyInstance,
  idp: ReturnType<typeof fakeIdp>,
  challenge: string,
): Promise<URL> {
  const start = await app.inject({
    method: "GET",
    url: `/api/auth/oidc/start?${new URLSearchParams({
      redirect_uri: "http://127.0.0.1:53682/callback",
      state: "app-state-123",
      code_challenge: challenge,
    })}`,
  });
  assert.equal(start.statusCode, 302, start.body);
  const authorize = new URL(start.headers.location as string);
  assert.equal(`${authorize.origin}${authorize.pathname}`, "https://idp.test/authorize");
  assert.equal(authorize.searchParams.get("redirect_uri"), "https://music.test/api/auth/oidc/callback");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  idp.state.nonce = authorize.searchParams.get("nonce")!;
  idp.state.challenge = authorize.searchParams.get("code_challenge")!;

  const callback = await app.inject({
    method: "GET",
    url: `/api/auth/oidc/callback?code=idp-code&state=${authorize.searchParams.get("state")}`,
  });
  assert.equal(callback.statusCode, 302, callback.body);
  return new URL(callback.headers.location as string);
}

test("OIDC sign-in end to end", async () => {
  const idp = fakeIdp(["music-users", "music-admins"]);
  const { app, db } = await setup(oidcConfig({ allowed: ["music-users"], admin: ["music-admins"] }), idp.fetchFn);

  const health = await app.inject({ method: "GET", url: "/api/health" });
  assert.deepEqual(health.json().auth.oidc, { name: "Authentik" });

  const verifier = randomToken(32);
  const back = await oidcRoundTrip(app, idp, pkceChallenge(verifier));
  assert.equal(back.origin, "http://127.0.0.1:53682");
  assert.equal(back.searchParams.get("state"), "app-state-123");
  const code = back.searchParams.get("code")!;
  assert.ok(code);

  const exchange = await app.inject({
    method: "POST",
    url: "/api/auth/exchange",
    payload: { code, code_verifier: verifier },
  });
  assert.equal(exchange.statusCode, 200, exchange.body);
  const auth = exchange.json() as AuthResponse;
  assert.equal(auth.user.username, "alice");
  assert.equal(auth.user.email, "alice@example.com");
  assert.equal(auth.user.isAdmin, true);

  const me = await app.inject({ method: "GET", url: "/api/me", headers: bearer(auth.token) });
  assert.equal(me.json().displayName, "Alice");

  // Handoff codes are single use.
  const replay = await app.inject({
    method: "POST",
    url: "/api/auth/exchange",
    payload: { code, code_verifier: verifier },
  });
  assert.equal(replay.statusCode, 400);

  await app.close();
  db.close();
});

test("OIDC rejects a wrong PKCE verifier from the app", async () => {
  const idp = fakeIdp([]);
  const { app, db } = await setup(oidcConfig(), idp.fetchFn);
  const back = await oidcRoundTrip(app, idp, pkceChallenge(randomToken(32)));
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/exchange",
    payload: { code: back.searchParams.get("code"), code_verifier: randomToken(32) },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_code_verifier");
  await app.close();
  db.close();
});

test("OIDC enforces allowed groups", async () => {
  const idp = fakeIdp(["someone-else"]);
  const { app, db } = await setup(oidcConfig({ allowed: ["music-users"] }), idp.fetchFn);
  const back = await oidcRoundTrip(app, idp, pkceChallenge(randomToken(32)));
  assert.equal(back.searchParams.get("error"), "access_denied");
  assert.equal(back.searchParams.get("code"), null);
  await app.close();
  db.close();
});

test("OIDC start refuses non-loopback redirects", async () => {
  const idp = fakeIdp([]);
  const { app, db } = await setup(oidcConfig(), idp.fetchFn);
  const res = await app.inject({
    method: "GET",
    url: `/api/auth/oidc/start?${new URLSearchParams({
      redirect_uri: "https://attacker.example/steal",
      state: "app-state-123",
      code_challenge: pkceChallenge("x"),
    })}`,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_redirect_uri");
  await app.close();
  db.close();
});
