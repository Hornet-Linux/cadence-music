import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { buildApp } from "../app.js";
import { openDb } from "../db.js";
import { createLocalUser, findUserByUsername } from "../auth/users.js";
import { libraryPlugin } from "../library/plugin.js";
import type { Config } from "../config.js";
import { genericAuditAction } from "./audit.js";
import { makeAdminPlugin } from "./plugin.js";
import { maskConfig, unmaskConfig, MASK } from "./pluginConfig.js";
import { compareVersions } from "./updates.js";
import { SERVER_VERSION } from "../version.js";

type FetchFn = typeof fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function setup(opts: { fetchFn?: FetchFn; config?: Partial<Config>; library?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-panel-"));
  const pluginsDir = path.join(dir, "community");
  fs.mkdirSync(path.join(pluginsDir, "demo"), { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, "package.json"), '{"type":"module"}');
  fs.writeFileSync(
    path.join(pluginsDir, "demo", "plugin.js"),
    `export default { id: "cadence.demo", name: "Demo plugin", version: "1.2.0", description: "Does demo things.",
      configFields: [{ key: "apiKey", label: "API key", type: "secret" }, { key: "city", label: "City" }], register() {} };`,
  );
  const db = openDb(":memory:");
  await createLocalUser(db, { username: "owner", password: "owner-password", isAdmin: true });
  await createLocalUser(db, { username: "member", password: "member-password" });
  const app = await buildApp({
    config: { host: "127.0.0.1", port: 0, dataDir: dir, musicDir: dir, scanIntervalMinutes: 0, trustProxy: false, logLevel: "silent", ...opts.config },
    db,
    secret: "s".repeat(64),
    logger: false,
    onSetupCode: () => undefined,
    // The library plugin rescans on start-up, which would sweep away tracks a test inserts by hand.
    plugins: [...(opts.library === false ? [] : [libraryPlugin]), makeAdminPlugin({ fetchFn: opts.fetchFn, communityDir: pluginsDir })],
  });
  const login = async (username: string, password: string) =>
    (await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } })).json().token as string;
  const as = (token: string) => (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  const close = async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { app, db, login, as, close };
}

test("switching a person off blocks sign-in and ends their sessions; switching on restores it", async () => {
  const { app, db, login, as, close } = await setup();
  const admin = as(await login("owner", "owner-password"));
  const memberToken = await login("member", "member-password");
  const member = as(memberToken);
  const id = findUserByUsername(db, "member")!.id;

  assert.equal((await member("GET", "/api/me")).statusCode, 200);
  assert.equal((await admin("PATCH", `/api/admin/users/${id}`, { disabled: true })).statusCode, 200);
  assert.equal((await member("GET", "/api/me")).statusCode, 401, "their old session no longer works");
  const blocked = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "member", password: "member-password" } });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().error, "account_disabled");
  const wrong = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "member", password: "nope-nope-nope" } });
  assert.equal(wrong.json().error, "invalid_credentials", "a wrong password does not reveal that the account is off");
  const list = (await admin("GET", "/api/admin/users")).json().items;
  assert.equal(list.find((u: { username: string }) => u.username === "member").disabled, true);

  assert.equal((await admin("PATCH", `/api/admin/users/${id}`, { disabled: false })).statusCode, 200);
  assert.ok(await login("member", "member-password"));
  await close();
});

test("the last admin who can sign in is protected from every angle", async () => {
  const { db, login, as, close } = await setup();
  const admin = as(await login("owner", "owner-password"));
  const owner = findUserByUsername(db, "owner")!;
  const member = findUserByUsername(db, "member")!;

  assert.equal((await admin("PATCH", `/api/admin/users/${owner.id}`, { disabled: true })).json().error, "cannot_disable_self");
  assert.equal((await admin("PATCH", `/api/admin/users/${owner.id}`, { isAdmin: false })).json().error, "last_admin");

  // A second admin who is switched off doesn't count as a way to manage the server.
  await admin("PATCH", `/api/admin/users/${member.id}`, { isAdmin: true });
  await admin("PATCH", `/api/admin/users/${member.id}`, { disabled: true });
  assert.equal((await admin("PATCH", `/api/admin/users/${owner.id}`, { isAdmin: false })).json().error, "last_admin");

  // With a second active admin, the first may be switched off by them.
  await admin("PATCH", `/api/admin/users/${member.id}`, { disabled: false });
  const second = as(await login("member", "member-password"));
  assert.equal((await second("PATCH", `/api/admin/users/${owner.id}`, { disabled: true })).statusCode, 200);
  assert.equal((await second("PATCH", `/api/admin/users/${member.id}`, { disabled: true })).json().error, "cannot_disable_self");
  assert.equal((await second("DELETE", `/api/admin/users/${owner.id}`)).statusCode, 204, "a switched-off admin can be deleted");
  await close();
});

test("deleting a person removes their saved per-person settings too", async () => {
  const { db, login, as, close } = await setup();
  const admin = as(await login("owner", "owner-password"));
  const member = findUserByUsername(db, "member")!;
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 0)").run(`plugin:x.y:user:${member.id}`, '{"key":"secret"}');
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 0)").run(`user:${member.id}:spotifyClientId`, '"abc"');
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 0)").run(`plugin:x.y:user:${member.id}9`, '"other person"');
  assert.equal((await admin("DELETE", `/api/admin/users/${member.id}`)).statusCode, 204);
  const left = db.prepare("SELECT key FROM settings WHERE key LIKE 'plugin:x.y:user:%' OR key LIKE 'user:%'").all() as { key: string }[];
  assert.deepEqual(left.map((r) => r.key), [`plugin:x.y:user:${member.id}9`]);
  await close();
});

test("community plugins: listed with state, toggled, configured, secrets hidden, restart flagged", async () => {
  const { db, login, as, close } = await setup();
  const admin = as(await login("owner", "owner-password"));
  const member = as(await login("member", "member-password"));
  assert.equal((await member("GET", "/api/admin/plugins")).statusCode, 403);

  let list = (await admin("GET", "/api/admin/plugins")).json();
  assert.equal(list.items.length, 1);
  const p = list.items[0];
  assert.equal(p.id, "cadence.demo");
  assert.equal(p.description, "Does demo things.");
  assert.equal(p.enabled, false);
  assert.equal(p.running, false);
  assert.equal(p.restartRequired, false);
  assert.equal(p.configFields.length, 2);

  const on = (await admin("PUT", "/api/admin/plugins/cadence.demo", { enabled: true })).json();
  assert.equal(on.enabled, true);
  assert.equal(on.restartRequired, true, "turning it on only applies after a restart");
  assert.equal(on.running, false);
  assert.equal((await admin("PUT", "/api/admin/plugins/cadence.demo", { enabled: false })).json().restartRequired, false, "turning it back off cancels the pending change");

  const saved = (await admin("PUT", "/api/admin/plugins/cadence.demo", { config: { apiKey: "sk-very-secret", city: "Oslo" } })).json();
  assert.deepEqual(saved.config, { apiKey: MASK, city: "Oslo" }, "the key is never sent back");
  assert.equal(saved.restartRequired, false, "settings of a plugin that isn't running need no restart");
  // Saving the mask back keeps the stored key.
  await admin("PUT", "/api/admin/plugins/cadence.demo", { config: { apiKey: MASK, city: "Bergen" } });
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'plugin:cadence.demo:config'").get() as { value: string };
  assert.equal(JSON.parse(stored.value).apiKey, "sk-very-secret", "sending the mask back keeps the stored key");
  list = (await admin("GET", "/api/admin/plugins")).json();
  assert.equal(list.items[0].config.city, "Bergen");

  assert.equal((await admin("PUT", "/api/admin/plugins/cadence.demo", { config: [1, 2] })).json().error, "invalid_config");
  assert.equal((await admin("PUT", "/api/admin/plugins/cadence.demo", { config: { big: "x".repeat(25_000) } })).json().error, "invalid_config");
  assert.equal((await admin("PUT", "/api/admin/plugins/cadence.demo", { enabled: "yes" })).json().error, "invalid_request");
  assert.equal((await admin("PUT", "/api/admin/plugins/nope", { enabled: true })).statusCode, 404);
  assert.equal((await admin("PUT", "/api/admin/plugins/..%2Fx", { enabled: true })).statusCode, 404);
  assert.equal((await admin("PUT", "/api/admin/plugins/cadence.demo", { config: null })).json().config, null);
  await close();
});

test("secret-looking config values are masked and restored", () => {
  const saved = { apiKey: "k1", nested: { token: "t1", name: "n" }, list: [{ password: "p" }] };
  const shown = maskConfig(saved) as typeof saved;
  assert.equal(shown.apiKey, MASK);
  assert.equal(shown.nested.token, MASK);
  assert.equal(shown.nested.name, "n");
  assert.equal(shown.list[0]!.password, MASK);
  assert.deepEqual(unmaskConfig(shown, saved), saved);
  assert.deepEqual(unmaskConfig({ ...shown, apiKey: "new" }, saved), { ...saved, apiKey: "new" });
});

test("the audit log records admin changes, never secrets, and skips failures and tests", async () => {
  const { app, login, as, close } = await setup({ fetchFn: (async () => json({ tag_name: "v9.9.9" })) as FetchFn });
  const admin = as(await login("owner", "owner-password"));
  const member = as(await login("member", "member-password"));
  await admin("POST", "/api/admin/users", { username: "newbie", password: "newbie-password" });
  await admin("POST", "/api/admin/users", { username: "newbie", password: "newbie-password" }); // 409, not logged
  await admin("PUT", "/api/admin/signup", { mode: "invite" });
  await admin("PUT", "/api/admin/plugins/cadence.demo", { enabled: true, config: { apiKey: "sk-very-secret" } });
  await admin("POST", "/api/admin/update-check"); // changes nothing
  await member("POST", "/api/admin/users", { username: "sneaky", password: "sneaky-password" }); // 403, not logged
  await admin("POST", "/api/library/scan");

  const log = (await admin("GET", "/api/admin/audit")).json();
  const actions = log.items.map((e: { action: string }) => e.action);
  assert.deepEqual(actions, ["library.scan", "plugin.update", "signup.update", "user.create"]);
  assert.ok(log.items.every((e: { actor: string }) => e.actor === "owner"));
  assert.ok(!JSON.stringify(log).includes("sk-very-secret"));
  assert.ok(!JSON.stringify(log).includes("newbie-password"));
  assert.equal(log.items[3].target, "newbie");
  assert.equal((await member("GET", "/api/admin/audit")).statusCode, 403);

  const page1 = (await admin("GET", "/api/admin/audit?limit=2")).json();
  assert.equal(page1.items.length, 2);
  assert.ok(page1.next);
  const page2 = (await admin("GET", `/api/admin/audit?limit=2&before=${page1.next}`)).json();
  assert.deepEqual(page2.items.map((e: { action: string }) => e.action), ["signup.update", "user.create"]);
  assert.equal(page2.next, null);
  void app;
  await close();
});

test("audit actions are only derived for successful admin writes", () => {
  assert.equal(genericAuditAction("GET", "/api/admin/users", 200), null);
  assert.equal(genericAuditAction("POST", "/api/admin/llm/test", 200), null);
  assert.equal(genericAuditAction("PUT", "/api/admin/jellyfin", 400), null);
  assert.equal(genericAuditAction("PUT", "/api/admin/jellyfin", 200), "jellyfin.update");
  assert.equal(genericAuditAction("POST", "/api/me/password", 200), null);
  assert.equal(genericAuditAction("POST", "/api/library/scan", 202), "library.scan");
});

test("update check compares against the latest GitHub release, only when asked", async () => {
  let calls = 0;
  let answer: () => Response = () => json({ tag_name: "v99.0.0", html_url: "https://github.com/Hornet-Linux/cadence-music/releases/tag/v99.0.0", published_at: "2030-01-01T00:00:00Z" });
  const { login, as, close } = await setup({ fetchFn: (async () => { calls++; return answer(); }) as FetchFn });
  const admin = as(await login("owner", "owner-password"));
  const before = (await admin("GET", "/api/admin/update-check")).json();
  assert.equal(before.status, null);
  assert.equal(calls, 0, "no request until someone asks");

  const found = (await admin("POST", "/api/admin/update-check")).json().status;
  assert.equal(found.latest, "v99.0.0");
  assert.equal(found.upToDate, false);
  assert.match(found.url, /^https:\/\/github\.com\/Hornet-Linux\/cadence-music\//);
  assert.equal((await admin("GET", "/api/admin/update-check")).json().status.latest, "v99.0.0", "the answer is remembered");

  answer = () => json({ tag_name: `v${SERVER_VERSION}`, html_url: "https://evil.example/x" });
  const same = (await admin("POST", "/api/admin/update-check")).json().status;
  assert.equal(same.upToDate, true);
  assert.equal(same.url, null, "only GitHub release links are passed on");

  answer = () => json({ tag_name: "nightly-2030-01-01" });
  assert.equal((await admin("POST", "/api/admin/update-check")).json().status.upToDate, null);
  answer = () => json({ message: "Not Found" }, 404);
  assert.match((await admin("POST", "/api/admin/update-check")).json().status.error, /No release/);
  answer = () => { throw new Error("offline"); };
  assert.match((await admin("POST", "/api/admin/update-check")).json().status.error, /offline/);
  answer = () => json({}, 500);
  assert.match((await admin("POST", "/api/admin/update-check")).json().status.error, /500/);
  await close();
});

test("version comparison", () => {
  assert.equal(compareVersions("0.2.0", "v0.10.0"), -1);
  assert.equal(compareVersions("1.0.0", "v1.0.0"), 0);
  assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
  assert.equal(compareVersions("0.2.0", "nightly"), null);
});

test("single sign-on status is read-only and checks the provider", async () => {
  const seen: string[] = [];
  const { login, as, close } = await setup({
    fetchFn: (async (url: string) => { seen.push(String(url)); return json({ issuer: "https://id.example.com" }); }) as unknown as FetchFn,
    config: {
      publicUrl: "https://music.example.com",
      oidc: { issuer: "https://id.example.com/app/", clientId: "cadence", clientSecret: "hush", displayName: "Authentik", scopes: "openid email", allowedGroups: ["music"], adminGroups: ["admins"] },
    },
  });
  const admin = as(await login("owner", "owner-password"));
  const sso = (await admin("GET", "/api/admin/sso")).json();
  assert.equal(sso.configured, true);
  assert.equal(sso.name, "Authentik");
  assert.equal(sso.hasClientSecret, true);
  assert.ok(!JSON.stringify(sso).includes("hush"), "the client secret is never sent");
  assert.equal(sso.discovery.ok, true);
  assert.deepEqual(seen, ["https://id.example.com/app/.well-known/openid-configuration"]);
  assert.equal(sso.callbackUrl, "https://music.example.com/api/auth/oidc/callback");
  assert.equal((await admin("PUT", "/api/admin/sso", { clientId: "x" })).statusCode, 404, "there is no way to change it here");
  await close();
});

test("single sign-on status says so when it isn't configured or the provider is down", async () => {
  const a = await setup();
  assert.deepEqual((await a.as(await a.login("owner", "owner-password"))("GET", "/api/admin/sso")).json(), { configured: false });
  await a.close();
  const b = await setup({
    fetchFn: (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as FetchFn,
    config: { oidc: { issuer: "https://id.example.com", clientId: "c", displayName: "ID", scopes: "openid", allowedGroups: [], adminGroups: [] } },
  });
  const sso = (await b.as(await b.login("owner", "owner-password"))("GET", "/api/admin/sso")).json();
  assert.equal(sso.discovery.ok, false);
  assert.match(sso.discovery.error, /ECONNREFUSED/);
  assert.equal(sso.publicUrlSet, false);
  await b.close();
});

test("overview and library report the server's health", async () => {
  const { db, login, as, close } = await setup({ library: false });
  db.prepare("INSERT INTO tracks (id, rel_path, title, artist, album, size, mtime_ms, added_at, duration_sec) VALUES ('a','a.mp3','A','X','Alb',1000,1,1,200)").run();
  db.prepare("INSERT INTO tracks (id, rel_path, title, artist, album, size, mtime_ms, added_at, duration_sec) VALUES ('b','b.mp3','B','Y','Alb',3000,1,1,100)").run();
  const admin = as(await login("owner", "owner-password"));
  const o = (await admin("GET", "/api/admin/overview")).json();
  assert.equal(o.version, SERVER_VERSION);
  assert.equal(o.tracks, 2);
  assert.ok(o.uptimeSec >= 0);
  assert.ok(o.activeSessions >= 1);
  assert.equal(o.communityPlugins.available, 1);
  assert.ok(o.storage.data === null || o.storage.data.freeBytes >= 0);
  const l = (await admin("GET", "/api/admin/library")).json();
  assert.deepEqual([l.tracks, l.artists, l.albums, l.bytes, l.durationSec], [2, 2, 1, 4000, 300]);
  assert.equal(l.exists, true);
  assert.equal(l.readable, true);
  await close();
});

test("invite codes can be regenerated and are validated", async () => {
  const { login, as, close } = await setup();
  const admin = as(await login("owner", "owner-password"));
  const first = (await admin("PUT", "/api/admin/signup", { mode: "invite", inviteCode: "friends-2030" })).json();
  assert.equal(first.inviteCode, "friends-2030");
  const next = (await admin("PUT", "/api/admin/signup", { mode: "invite", regenerate: true })).json();
  assert.notEqual(next.inviteCode, "friends-2030");
  assert.match(next.inviteCode, /^[A-Za-z0-9_-]{6,64}$/);
  assert.equal((await admin("PUT", "/api/admin/signup", { mode: "invite", inviteCode: "no spaces!" })).json().error, "invalid_invite_code");
  assert.equal((await admin("PUT", "/api/admin/signup", { mode: "wide-open" })).json().error, "invalid_mode");
  await close();
});

test("the admin page covers every section and never writes HTML", async () => {
  const { app, close } = await setup();
  const res = await app.inject({ method: "GET", url: "/admin" });
  assert.match(String(res.headers["content-security-policy"]), /default-src 'none'/);
  const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(res.body)![1]!;
  assert.doesNotThrow(() => new vm.Script(script), "the inline script parses");
  for (const label of ["Overview", "People", "Sign-up", "Library", "Jellyfin", "AI providers", "Single sign-on", "Plugins", "Activity"]) {
    assert.ok(script.includes(`"${label}"`), label);
  }
  for (const endpoint of [
    "/api/admin/overview", "/api/admin/library", "/api/admin/users", "/api/admin/signup", "/api/admin/plugins", "/api/admin/audit",
    "/api/admin/update-check", "/api/admin/sso", "/api/library/scan", "/api/library/status", "/api/admin/jellyfin", "/api/admin/llm/providers",
  ]) {
    assert.ok(script.includes(endpoint), endpoint);
  }
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(script));
  assert.ok(res.body.includes('name="viewport"'));
  await close();
});

test("the account page is served with the same lock-down", async () => {
  const { app, close } = await setup();
  const res = await app.inject({ method: "GET", url: "/account" });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-security-policy"]), /frame-ancestors 'none'/);
  const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(res.body)![1]!;
  assert.doesNotThrow(() => new vm.Script(script));
  for (const endpoint of ["/api/me/account", "/api/me/password", "/api/me/sessions", "/api/me/export", "/api/me/history", "/api/me/delete-account"]) {
    assert.ok(script.includes(endpoint), endpoint);
  }
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(script));
  await close();
});