import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../app.js";
import { openDb } from "../db.js";
import { createLocalUser } from "./users.js";
import { makeAdminPlugin } from "../admin/plugin.js";
import { listAudit } from "../admin/audit.js";

// Requests come from different client addresses through a trusted proxy hop.
async function setup(env: { signup?: { mode: "open" } | { mode: "invite"; inviteCode: string } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-auth-hard-"));
  const db = openDb(":memory:");
  await createLocalUser(db, { username: "owner", password: "owner-password", isAdmin: true });
  await createLocalUser(db, { username: "alice", password: "alice-password" });
  const app = await buildApp({
    config: { host: "127.0.0.1", port: 0, dataDir: dir, musicDir: dir, scanIntervalMinutes: 0, trustProxy: 1, logLevel: "silent", ...env },
    db,
    secret: "s".repeat(64),
    logger: false,
    onSetupCode: () => undefined,
    plugins: [makeAdminPlugin({ communityDir: path.join(dir, "none") })],
  });
  const login = (username: string, password: string, ip: string) =>
    app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password }, headers: { "x-forwarded-for": ip } });
  const close = async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { app, db, login, close };
}

test("an account locked by strangers still signs in from a device it used recently", async () => {
  const t = await setup();
  assert.equal((await t.login("alice", "alice-password", "10.0.0.1")).statusCode, 200, "alice's own laptop");
  // 30 wrong passwords for alice from many addresses (each under the per-address limit).
  for (let i = 0; i < 30; i++) await t.login("alice", "wrong-password", `198.51.100.${i % 3}`);
  assert.equal((await t.login("alice", "alice-password", "203.0.113.9")).statusCode, 429, "a new address is locked out");
  assert.equal((await t.login("alice", "alice-password", "10.0.0.1")).statusCode, 200, "her known device is not");

  const events = listAudit(t.db, 20).items.map((e) => `${e.action} ${e.target}`);
  assert.ok(events.includes("signin.locked alice"), "the lockout is in the activity log");
  assert.ok(events.some((e) => e.startsWith("signin.ip_locked 198.51.100.")));
  await t.close();
});

test("sign-up attempts are limited, not just successful sign-ups", async () => {
  const t = await setup({ signup: { mode: "open" } });
  const statuses: number[] = [];
  for (let i = 0; i < 21; i++) {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: i % 2 ? "alice" : "owner", password: "long-enough-password" },
      headers: { "x-forwarded-for": "192.0.2.7" },
    });
    statuses.push(res.statusCode);
  }
  assert.ok(statuses.slice(0, 20).every((s) => s === 409), "probing taken names");
  assert.equal(statuses[20], 429);
  await t.close();
});

test("invite codes: long when generated, not in the overview, only on the sign-up endpoint", async () => {
  const t = await setup();
  const token = (await t.login("owner", "owner-password", "10.0.0.2")).json().token as string;
  const as = (method: "GET" | "PUT", url: string, payload?: object) =>
    t.app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });

  assert.equal((await as("PUT", "/api/admin/signup", { mode: "invite", inviteCode: "short1" })).statusCode, 400);
  const made = (await as("PUT", "/api/admin/signup", { mode: "invite", regenerate: true })).json();
  assert.ok(made.inviteCode.length >= 16);
  const overview = (await as("GET", "/api/admin/overview")).json();
  assert.deepEqual(overview.signup, { mode: "invite", inviteCodeSet: true });
  assert.ok(!JSON.stringify(overview).includes(made.inviteCode));
  assert.equal((await as("GET", "/api/admin/signup")).json().inviteCode, made.inviteCode);
  await t.close();
});
