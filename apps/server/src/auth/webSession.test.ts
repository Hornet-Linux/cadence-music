import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../app.js";
import { openDb } from "../db.js";
import { createLocalUser } from "./users.js";
import { createSpotifySessionPlugin } from "../integrations/spotifySession.js";

async function setup(fetchFn?: (input: string, init?: RequestInit) => Promise<Response>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-websession-"));
  const db = openDb(":memory:");
  await createLocalUser(db, { username: "alice", password: "alice-password" });
  const app = await buildApp({
    config: { host: "127.0.0.1", port: 0, dataDir: dir, musicDir: dir, scanIntervalMinutes: 0, trustProxy: false, logLevel: "silent" },
    db,
    secret: "s".repeat(64),
    logger: false,
    onSetupCode: () => undefined,
    plugins: [createSpotifySessionPlugin({ fetchFn })],
  });
  const close = async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { app, db, close };
}

const cookieOf = (setCookie: string | string[] | undefined) => String(setCookie ?? "").split(";")[0]!;

test("the web player signs in with an HttpOnly cookie and never sees the token", async () => {
  const t = await setup();
  const res = await t.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "alice", password: "alice-password" },
    headers: { "x-cadence-session": "cookie" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().token, "");
  assert.equal(res.json().user.username, "alice");
  const setCookie = String(res.headers["set-cookie"]);
  assert.match(setCookie, /^cadence_session=[\w-]{20,}; Path=\/api; HttpOnly; SameSite=Strict/);
  const cookie = cookieOf(res.headers["set-cookie"]);

  // Reads work with the cookie alone.
  assert.equal((await t.app.inject({ method: "GET", url: "/api/me", headers: { cookie } })).statusCode, 200);
  // Writes need the CSRF header, which other sites can't send.
  const noHeader = await t.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
  assert.equal(noHeader.statusCode, 403);
  const out = await t.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie, "x-cadence-csrf": "1" } });
  assert.equal(out.statusCode, 204);
  assert.match(String(out.headers["set-cookie"]), /Max-Age=0/);
  assert.equal((await t.app.inject({ method: "GET", url: "/api/me", headers: { cookie } })).statusCode, 401);
  await t.close();
});

test("apps still get a bearer token; an old web token moves into the cookie", async () => {
  const t = await setup();
  const res = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "alice", password: "alice-password" } });
  const token = res.json().token as string;
  assert.ok(token.length > 20);
  assert.equal(res.headers["set-cookie"], undefined);

  const moved = await t.app.inject({
    method: "POST",
    url: "/api/auth/web-session",
    headers: { authorization: `Bearer ${token}`, "x-cadence-session": "cookie" },
  });
  assert.equal(moved.statusCode, 200);
  assert.equal(moved.json().token, "");
  const cookie = cookieOf(moved.headers["set-cookie"]);
  assert.equal(cookie, `cadence_session=${token}`, "the same session");
  await t.close();
});

test("Spotify for the web player: the server keeps the refresh token, the page gets access tokens", async () => {
  const calls: URLSearchParams[] = [];
  let refreshCount = 0;
  const spotify = async (_url: string, init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body));
    calls.push(params);
    if (params.get("grant_type") === "authorization_code") {
      return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
    }
    refreshCount++;
    if (params.get("refresh_token") === "revoked") return Response.json({ error: "invalid_grant" }, { status: 400 });
    return Response.json({ access_token: `access-r${refreshCount}`, refresh_token: `refresh-r${refreshCount}`, expires_in: 30 });
  };
  const t = await setup(spotify);
  const login = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "alice", password: "alice-password" } });
  const headers = { authorization: `Bearer ${login.json().token}` };
  const clientId = "0123456789abcdef0123456789abcdef";

  const bad = await t.app.inject({
    method: "POST",
    url: "/api/me/spotify/connect",
    headers,
    payload: { code: "abcdefghijkl", codeVerifier: "v".repeat(43), clientId, redirectUri: "https://evil.example/steal" },
  });
  assert.equal(bad.statusCode, 400, "only the web player's own callback");

  const connected = await t.app.inject({
    method: "POST",
    url: "/api/me/spotify/connect",
    headers,
    payload: { code: "abcdefghijkl", codeVerifier: "v".repeat(43), clientId, redirectUri: "https://music.example/app/spotify/callback" },
  });
  assert.equal(connected.statusCode, 200);
  assert.equal(connected.json().accessToken, "access-1");
  assert.ok(!connected.body.includes("refresh"), "the refresh token never reaches the page");
  const stored = t.db.prepare("SELECT refresh_enc FROM spotify_sessions").get() as { refresh_enc: string };
  assert.ok(!stored.refresh_enc.includes("refresh-1"), "encrypted at rest");

  // A cached token comes back without calling Spotify; an expiring one is refreshed (and rotated).
  assert.equal((await t.app.inject({ method: "POST", url: "/api/me/spotify/token", headers })).json().accessToken, "access-1");
  assert.equal(calls.length, 1);
  t.db.prepare("UPDATE spotify_sessions SET refresh_enc = refresh_enc").run();
  const status = await t.app.inject({ method: "GET", url: "/api/me/spotify", headers });
  assert.deepEqual(status.json(), { connected: true, clientId });

  assert.equal((await t.app.inject({ method: "DELETE", url: "/api/me/spotify", headers })).statusCode, 204);
  assert.equal((await t.app.inject({ method: "POST", url: "/api/me/spotify/token", headers })).statusCode, 404);
  await t.close();
});
