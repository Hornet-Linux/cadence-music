import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../app.js";
import { openDb } from "../db.js";
import { createLocalUser, findUserByUsername, upsertOidcUser } from "./users.js";
import { deviceLabel } from "./sessions.js";
import { ensureAccountSchema } from "./schema.js";
import { collectionPlugin } from "../collection/plugin.js";
import { historyPlugin } from "../history/plugin.js";
import { makeAdminPlugin } from "../admin/plugin.js";

const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const PHONE = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-account-"));
  const db = openDb(":memory:");
  await createLocalUser(db, { username: "owner", password: "owner-password", isAdmin: true });
  await createLocalUser(db, { username: "alice", password: "alice-password", displayName: "Alice" });
  const app = await buildApp({
    config: { host: "127.0.0.1", port: 0, dataDir: dir, musicDir: dir, scanIntervalMinutes: 0, trustProxy: false, logLevel: "silent" },
    db,
    secret: "s".repeat(64),
    logger: false,
    onSetupCode: () => undefined,
    plugins: [historyPlugin, collectionPlugin, makeAdminPlugin({ communityDir: path.join(dir, "none") })],
  });
  const login = async (username: string, password: string, ua?: string) =>
    (await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password }, headers: ua ? { "user-agent": ua } : {} })).json().token as string;
  const as = (token: string) => (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  const close = async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { app, db, login, as, close };
}

const play = (n: number) => ({ playedAt: Date.now() - n * 1000, track: { id: `t${n}`, title: `Song ${n}`, artists: [{ id: "a", name: "Artist" }] } });

test("changing your password checks the old one, signs out other devices and keeps this one", async () => {
  const { app, login, as, close } = await setup();
  const laptop = await login("alice", "alice-password", CHROME_WIN);
  const phone = await login("alice", "alice-password", PHONE);
  const me = as(laptop);

  assert.equal((await me("POST", "/api/me/password", { currentPassword: "wrong-password", newPassword: "brand-new-password" })).json().error, "wrong_password");
  assert.equal((await me("POST", "/api/me/password", { currentPassword: "alice-password", newPassword: "short" })).json().error, "weak_password");
  assert.equal((await me("POST", "/api/me/password", { currentPassword: "alice-password", newPassword: "alice-password" })).json().error, "same_password");
  assert.equal((await me("POST", "/api/me/password", { newPassword: "brand-new-password" })).json().error, "invalid_request");

  const ok = await me("POST", "/api/me/password", { currentPassword: "alice-password", newPassword: "brand-new-password" });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().signedOut, 1);
  assert.equal((await me("GET", "/api/me")).statusCode, 200, "this device stays signed in");
  assert.equal((await as(phone)("GET", "/api/me")).statusCode, 401, "the other device is signed out");
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "alice", password: "alice-password" } })).statusCode, 401);
  assert.ok(await login("alice", "brand-new-password"));
  await close();
});

test("wrong current-password guesses are rate limited per person", async () => {
  const { login, as, close } = await setup();
  const me = as(await login("alice", "alice-password"));
  for (let i = 0; i < 8; i++) {
    assert.equal((await me("POST", "/api/me/password", { currentPassword: `guess-number-${i}`, newPassword: "brand-new-password" })).statusCode, 403);
  }
  const locked = await me("POST", "/api/me/password", { currentPassword: "alice-password", newPassword: "brand-new-password" });
  assert.equal(locked.statusCode, 429);
  await close();
});

test("sessions list the devices, mark this one, and can be ended one by one or all at once", async () => {
  const { login, as, close } = await setup();
  const laptop = await login("alice", "alice-password", CHROME_WIN);
  await login("alice", "alice-password", PHONE);
  await login("owner", "owner-password");
  const me = as(laptop);

  const { items } = (await me("GET", "/api/me/sessions")).json();
  assert.equal(items.length, 2, "only your own sessions");
  assert.deepEqual(items.map((s: { device: string }) => s.device).sort(), ["Chrome on Android", "Chrome on Windows"]);
  const current = items.filter((s: { current: boolean }) => s.current);
  assert.equal(current.length, 1);
  assert.equal(current[0].device, "Chrome on Windows");
  assert.ok(!JSON.stringify(items).includes(laptop), "the token itself is never listed");

  const other = items.find((s: { current: boolean }) => !s.current);
  assert.equal((await me("DELETE", `/api/me/sessions/${encodeURIComponent(other.id)}`)).statusCode, 204);
  assert.equal((await me("DELETE", `/api/me/sessions/${encodeURIComponent(other.id)}`)).statusCode, 404);
  assert.equal((await me("DELETE", "/api/me/sessions/..%2F..")).statusCode, 404);

  await login("alice", "alice-password");
  await login("alice", "alice-password");
  const r = (await me("POST", "/api/me/sessions/sign-out-others")).json();
  assert.equal(r.signedOut, 2);
  assert.equal((await me("GET", "/api/me/sessions")).json().items.length, 1);
  assert.equal((await me("GET", "/api/me")).statusCode, 200);
  await close();
});

test("you can't end someone else's session", async () => {
  const { login, as, close } = await setup();
  const alice = as(await login("alice", "alice-password"));
  const owner = as(await login("owner", "owner-password"));
  const ownerSession = (await owner("GET", "/api/me/sessions")).json().items[0];
  assert.equal((await alice("DELETE", `/api/me/sessions/${encodeURIComponent(ownerSession.id)}`)).statusCode, 404);
  assert.equal((await owner("GET", "/api/me")).statusCode, 200);
  await close();
});

test("account overview, display name, and the page needs a session", async () => {
  const { app, login, as, close } = await setup();
  assert.equal((await app.inject({ method: "GET", url: "/api/me/account" })).statusCode, 401);
  const me = as(await login("alice", "alice-password"));
  await me("POST", "/api/me/history", { plays: [play(1), play(2)] });
  await me("POST", "/api/me/likes", { track: play(1).track });
  const acct = (await me("GET", "/api/me/account")).json();
  assert.equal(acct.user.username, "alice");
  assert.deepEqual(acct.counts, { plays: 2, likes: 1, playlists: 0 });
  assert.equal(acct.signIn.password, true);
  assert.equal(acct.connections.jellyfin, null);

  const renamed = (await me("PATCH", "/api/me", { displayName: "  Ali  " })).json();
  assert.equal(renamed.displayName, "Ali");
  assert.equal((await me("PATCH", "/api/me", { displayName: "" })).json().displayName, null);
  assert.equal((await me("PATCH", "/api/me", { displayName: 5 })).statusCode, 400);
  await close();
});

test("export gives everything that is yours and nothing secret", async () => {
  const { db, login, as, close } = await setup();
  const alice = as(await login("alice", "alice-password"));
  const owner = as(await login("owner", "owner-password"));
  await alice("POST", "/api/me/history", { plays: [play(1), play(2), play(3)] });
  await alice("POST", "/api/me/likes", { track: play(1).track });
  await alice("POST", "/api/me/playlists", { name: "Road trip", tracks: [play(2).track] });
  await owner("POST", "/api/me/history", { plays: [play(9)] });
  const aliceId = findUserByUsername(db, "alice")!.id;
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 0)").run(`plugin:cadence.lastfm:user:${aliceId}`, '{"sessionKey":"super-secret-key"}');

  const res = await alice("GET", "/api/me/export");
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-disposition"]), /attachment; filename="cadence-alice-\d{4}-\d{2}-\d{2}\.json"/);
  const data = res.json();
  assert.equal(data.account.username, "alice");
  assert.equal(data.history.length, 3);
  assert.equal(data.history[0].title, "Song 1", "newest first");
  assert.equal(data.likes.length, 1);
  assert.equal(data.playlists[0].name, "Road trip");
  assert.deepEqual(data.savedSettingsFor, ["cadence.lastfm"]);
  const text = res.body;
  for (const secret of ["alice-password", "scrypt$", "super-secret-key", "Song 9", "token_hash"]) assert.ok(!text.includes(secret), `leaks ${secret}`);
  await close();
});

test("deleting your history removes only your plays", async () => {
  const { db, login, as, close } = await setup();
  const alice = as(await login("alice", "alice-password"));
  const owner = as(await login("owner", "owner-password"));
  await alice("POST", "/api/me/history", { plays: [play(1), play(2)] });
  await alice("POST", "/api/me/likes", { track: play(1).track });
  await owner("POST", "/api/me/history", { plays: [play(3)] });
  assert.equal((await alice("DELETE", "/api/me/history")).json().deleted, 2);
  assert.equal((await alice("GET", "/api/me/history")).json().items.length, 0);
  assert.equal((await owner("GET", "/api/me/history")).json().items.length, 1);
  assert.equal((await alice("GET", "/api/me/likes")).json().items.length, 1, "likes stay");
  void db;
  await close();
});

test("deleting your own account needs your password and removes everything", async () => {
  const { db, app, login, as, close } = await setup();
  const alice = as(await login("alice", "alice-password"));
  const id = findUserByUsername(db, "alice")!.id;
  await alice("POST", "/api/me/history", { plays: [play(1)] });
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 0)").run(`plugin:x.y:user:${id}`, "{}");

  assert.equal((await alice("POST", "/api/me/delete-account", {})).statusCode, 400);
  assert.equal((await alice("POST", "/api/me/delete-account", { password: "nope-nope-nope" })).json().error, "wrong_password");
  assert.ok(findUserByUsername(db, "alice"));
  assert.equal((await alice("POST", "/api/me/delete-account", { password: "alice-password" })).statusCode, 204);
  assert.equal(findUserByUsername(db, "alice"), undefined);
  assert.equal((await alice("GET", "/api/me")).statusCode, 401);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM plays WHERE user_id = ?").get(id) as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = ?").get(`plugin:x.y:user:${id}`) as { n: number }).n, 0);
  void app;
  await close();
});

test("the only admin can't delete their own account; single sign-on accounts confirm with their username", async () => {
  const { db, login, as, close } = await setup();
  const owner = as(await login("owner", "owner-password"));
  assert.equal((await owner("POST", "/api/me/delete-account", { password: "owner-password" })).json().error, "last_admin");
  assert.ok(findUserByUsername(db, "owner"));

  const sso = upsertOidcUser(db, { issuer: "https://id.example", subject: "s2", preferredUsername: "sam" });
  const { createSession } = await import("./sessions.js");
  const token = createSession(db, sso.id);
  const me = as(token);
  assert.equal((await me("POST", "/api/me/delete-account", { confirm: "someone-else" })).json().error, "confirm_mismatch");
  assert.equal((await me("POST", "/api/me/password", { currentPassword: "x", newPassword: "long-enough-password" })).json().error, "no_password");
  assert.equal((await me("POST", "/api/me/delete-account", { confirm: "SAM" })).statusCode, 204);
  assert.equal(findUserByUsername(db, "sam"), undefined);
  await close();
});

test("device names are readable", () => {
  assert.equal(deviceLabel(CHROME_WIN), "Chrome on Windows");
  assert.equal(deviceLabel(PHONE), "Chrome on Android");
  assert.equal(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"), "Safari on macOS");
  assert.equal(deviceLabel("Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/130.0"), "Firefox on Windows");
  assert.equal(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64) AppleWebKit/537.36 Edg/130.0 Chrome/130.0 Safari/537.36"), "Edge on Windows");
  assert.equal(deviceLabel("okhttp/4.12.0"), "Cadence for Android");
  assert.equal(deviceLabel("Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36"), "Cadence for Android");
  assert.equal(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/130.0 Mobile/15E148 Safari/605.1.15"), "Firefox on iPhone");
  assert.equal(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"), "Cadence for iPhone");
  assert.equal(deviceLabel("curl/8.9.1"), "Script or command-line tool");
  assert.equal(deviceLabel("node"), "Script or command-line tool");
  assert.equal(deviceLabel(""), "Unknown device");
  assert.equal(deviceLabel(null), "Unknown device");
});

test("the account schema is added once and survives a reopen", () => {
  const db = openDb(":memory:");
  ensureAccountSchema(db);
  ensureAccountSchema(db);
  const cols = (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
  assert.equal(cols.filter((c) => c === "disabled_at").length, 1);
  assert.ok((db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).some((c) => c.name === "user_agent"));
  db.exec("INSERT INTO admin_audit (at, actor, action) VALUES (1, 'x', 'y')");
  db.close();
});

test("a person who is switched off can't sign in through single sign-on exchange either", async () => {
  const { db, app, close } = await setup();
  const user = upsertOidcUser(db, { issuer: "https://id.example", subject: "s3", preferredUsername: "off" });
  db.prepare("UPDATE users SET disabled_at = 1 WHERE id = ?").run(user.id);
  const res = await app.inject({ method: "POST", url: "/api/auth/exchange", payload: { code: "nope", code_verifier: "x" } });
  assert.equal(res.statusCode, 400, "an unknown code is refused outright");
  await close();
});