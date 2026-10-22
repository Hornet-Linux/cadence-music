import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../app.js";
import { listUsers } from "../admin/plugin.js";
import { openDb } from "../db.js";
import { IDLE_LIMIT_MS, createSession, purgeExpiredSessions, startSessionPurge, userForToken } from "./sessions.js";
import { createLocalUser } from "./users.js";
import { sha256 } from "../util/crypto.js";

const DAY = 86_400_000;

async function fixture() {
  const db = openDb(":memory:");
  const user = await createLocalUser(db, { username: "alice", password: "alice-password" });
  const age = (token: string, ms: number) =>
    db.prepare("UPDATE sessions SET last_used_at = ? WHERE token_hash = ?").run(Date.now() - ms, sha256(token));
  const total = () => (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
  return { db, user, age, total };
}

test("purgeExpiredSessions deletes only sessions idle past the limit", async () => {
  const { db, user, age, total } = await fixture();
  const live = createSession(db, user.id);
  const stale = createSession(db, user.id);
  const edge = createSession(db, user.id);
  age(stale, IDLE_LIMIT_MS + DAY);
  age(edge, IDLE_LIMIT_MS - DAY);
  assert.equal(purgeExpiredSessions(db), 1);
  assert.equal(total(), 2);
  assert.ok(userForToken(db, live));
  assert.ok(userForToken(db, edge));
  assert.equal(userForToken(db, stale), null);
  db.close();
});

test("startSessionPurge sweeps at start-up and on its timer, and can be stopped", async () => {
  const { db, user, age, total } = await fixture();
  const stale = createSession(db, user.id);
  age(stale, IDLE_LIMIT_MS + DAY);
  const stop = startSessionPurge(db, 20);
  assert.equal(total(), 0, "purged immediately");

  const later = createSession(db, user.id);
  age(later, IDLE_LIMIT_MS + DAY);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(total(), 0, "purged again by the timer");

  stop();
  const after = createSession(db, user.id);
  age(after, IDLE_LIMIT_MS + DAY);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(total(), 1, "no sweeps after stopping");
  db.close();
});

test("closing the app stops the purge timer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-sessions-"));
  const { db, user, age, total } = await fixture();
  const stale = createSession(db, user.id);
  age(stale, IDLE_LIMIT_MS + DAY);
  const app = await buildApp({
    config: { host: "127.0.0.1", port: 0, dataDir: dir, musicDir: dir, scanIntervalMinutes: 0, trustProxy: false, logLevel: "silent" },
    db,
    secret: "s".repeat(64),
    logger: false,
    onSetupCode: () => undefined,
  });
  assert.equal(total(), 0, "buildApp purges at start-up");
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the admin people list counts only live sessions", async () => {
  const { db, user, age } = await fixture();
  createSession(db, user.id);
  const stale = createSession(db, user.id);
  const staler = createSession(db, user.id);
  age(stale, IDLE_LIMIT_MS + DAY);
  age(staler, IDLE_LIMIT_MS + 2 * DAY);
  const [row] = listUsers(db);
  assert.equal(row.sessions, 1);
  assert.ok(row.lastSeenAt && Date.now() - row.lastSeenAt < IDLE_LIMIT_MS);

  db.prepare("UPDATE sessions SET last_used_at = ?").run(Date.now() - IDLE_LIMIT_MS - DAY);
  const [idle] = listUsers(db);
  assert.equal(idle.sessions, 0);
  assert.equal(idle.lastSeenAt, null);
  db.close();
});
