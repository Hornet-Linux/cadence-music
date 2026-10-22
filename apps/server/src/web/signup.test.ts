import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthResponse } from "@uma/shared";
import { buildApp } from "../app.js";
import { loadConfig, type Config } from "../config.js";
import { openDb } from "../db.js";
import { createLocalUser } from "../auth/users.js";

async function setup(signup: Config["signup"], withAdmin = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-signup-"));
  const db = openDb(":memory:");
  if (withAdmin) await createLocalUser(db, { username: "owner", password: "owner-password", isAdmin: true });
  const app = await buildApp({
    config: {
      host: "127.0.0.1",
      port: 0,
      dataDir: dir,
      musicDir: dir,
      scanIntervalMinutes: 0,
      trustProxy: false,
      logLevel: "silent",
      signup,
    },
    db,
    secret: "s".repeat(64),
    logger: false,
    onSetupCode: () => undefined,
  });
  const register = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/auth/register", payload });
  const close = async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { app, register, close };
}

test("config parses SIGNUP_MODE", () => {
  assert.equal(loadConfig({}).signup, undefined);
  assert.deepEqual(loadConfig({ SIGNUP_MODE: "open" }).signup, { mode: "open" });
  assert.deepEqual(loadConfig({ SIGNUP_MODE: "invite", SIGNUP_INVITE_CODE: "friends-only" }).signup, {
    mode: "invite",
    inviteCode: "friends-only",
  });
  assert.throws(() => loadConfig({ SIGNUP_MODE: "invite" }), /SIGNUP_INVITE_CODE/);
  assert.throws(() => loadConfig({ SIGNUP_MODE: "maybe" }), /SIGNUP_MODE/);
});

test("sign-up is closed by default", async () => {
  const { app, register, close } = await setup(undefined);
  assert.equal((await app.inject({ method: "GET", url: "/api/health" })).json().auth.signup, "closed");
  assert.equal((await register({ username: "x", password: "a-long-password" })).statusCode, 403);
  const page = await app.inject({ method: "GET", url: "/" });
  assert.match(page.body, /Sign-up is closed/);
  await close();
});

test("sign-up stays closed until the owner has claimed the server", async () => {
  const { app, register, close } = await setup({ mode: "open" }, false);
  assert.equal((await app.inject({ method: "GET", url: "/api/health" })).json().auth.signup, "closed");
  const res = await register({ username: "early", password: "a-long-password" });
  assert.equal(res.statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: "/api/health" })).json().setupRequired, true);
  await close();
});

test("open sign-up creates a regular account", async () => {
  const { app, register, close } = await setup({ mode: "open" });
  assert.equal((await app.inject({ method: "GET", url: "/api/health" })).json().auth.signup, "open");

  const ok = await register({ username: "alice", password: "a-long-password", displayName: "Alice" });
  assert.equal(ok.statusCode, 200, ok.body);
  const auth = ok.json() as AuthResponse;
  assert.equal(auth.user.username, "alice");
  assert.equal(auth.user.displayName, "Alice");
  assert.equal(auth.user.isAdmin, false, "sign-ups are never admins");

  assert.equal((await register({ username: "ALICE", password: "a-long-password" })).json().error, "username_taken");
  assert.equal((await register({ username: "bad name", password: "a-long-password" })).json().error, "invalid_username");
  assert.equal((await register({ username: "bob", password: "short" })).json().error, "weak_password");

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "alice", password: "a-long-password" },
  });
  assert.equal(login.statusCode, 200);
  await close();
});

test("invite sign-up requires the code", async () => {
  const { app, register, close } = await setup({ mode: "invite", inviteCode: "friends-only" });
  assert.equal((await app.inject({ method: "GET", url: "/api/health" })).json().auth.signup, "invite");
  assert.equal((await register({ username: "eve", password: "a-long-password" })).statusCode, 403);
  assert.equal(
    (await register({ username: "eve", password: "a-long-password", inviteCode: "wrong" })).json().error,
    "invalid_invite_code",
  );
  const ok = await register({ username: "carol", password: "a-long-password", inviteCode: "friends-only" });
  assert.equal(ok.statusCode, 200, ok.body);
  const page = await app.inject({ method: "GET", url: "/signup" });
  assert.match(page.body, /Invite code/);
  await close();
});

test("invite codes cannot be brute-forced", async () => {
  const { register, close } = await setup({ mode: "invite", inviteCode: "abc123" });
  for (let i = 0; i < 10; i++) {
    const res = await register({ username: "eve", password: "a-long-password", inviteCode: `guess${i}` });
    assert.equal(res.statusCode, 403);
  }
  // Even the right code is refused once the address has used up its guesses.
  const locked = await register({ username: "eve", password: "a-long-password", inviteCode: "abc123" });
  assert.equal(locked.statusCode, 429);
  assert.equal(locked.json().error, "too_many_attempts");
  await close();
});

test("the sign-up page is locked down", async () => {
  const { app, close } = await setup({ mode: "open" });
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /text\/html/);
  const csp = String(res.headers["content-security-policy"]);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
  assert.ok(nonce && res.body.includes(`nonce="${nonce}"`), "inline script carries the CSP nonce");
  assert.match(res.body, /Create your account/);
  await close();
});

test("sign-ups are rate limited per address", async () => {
  const { register, close } = await setup({ mode: "open" });
  for (let i = 0; i < 5; i++) {
    assert.equal((await register({ username: `user${i}`, password: "a-long-password" })).statusCode, 200);
  }
  assert.equal((await register({ username: "user5", password: "a-long-password" })).statusCode, 429);
  await close();
});
