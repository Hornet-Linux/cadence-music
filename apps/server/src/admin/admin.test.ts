import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { buildApp } from "../app.js";
import { openDb } from "../db.js";
import { createLocalUser } from "../auth/users.js";

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-admin-"));
  const db = openDb(":memory:");
  await createLocalUser(db, { username: "owner", password: "owner-password", isAdmin: true });
  await createLocalUser(db, { username: "member", password: "member-password" });
  const app = await buildApp({
    config: { host: "127.0.0.1", port: 0, dataDir: dir, musicDir: dir, scanIntervalMinutes: 0, trustProxy: false, logLevel: "silent" },
    db,
    secret: "s".repeat(64),
    logger: false,
    onSetupCode: () => undefined,
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
  return { app, login, as, close };
}

test("the admin page is served", async () => {
  const { app, close } = await setup();
  const res = await app.inject({ method: "GET", url: "/admin" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-security-policy"] as string, /nonce-/);
  await close();
});

test("the admin page's script is valid, has the Jellyfin and AI sections, and never writes HTML", async () => {
  const { app, close } = await setup();
  const html = (await app.inject({ method: "GET", url: "/admin" })).body;
  const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)![1];
  assert.doesNotThrow(() => new vm.Script(script), "the inline script parses");
  for (const label of ["Jellyfin", "AI providers"]) assert.ok(script.includes(`"${label}"`), label);
  for (const endpoint of ["/api/admin/jellyfin", "/api/admin/jellyfin/test", "/api/admin/llm/providers", "/api/admin/llm/test", "/api/llm/presets"]) {
    assert.ok(script.includes(endpoint), endpoint);
  }
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(script), "text only goes through textContent");
  assert.match(script, /opts\.body != null \? \{ "content-type": "application\/json" \}/, "JSON content type only when there is a body (DELETE/POST without one would be rejected)");
  await close();
});

test("admin API needs an admin", async () => {
  const { login, as, close } = await setup();
  const member = as(await login("member", "member-password"));
  assert.equal((await member("GET", "/api/admin/users")).statusCode, 403);
  await close();
});

test("admins manage people with guards", async () => {
  const { login, as, close } = await setup();
  const admin = as(await login("owner", "owner-password"));
  const { items } = (await admin("GET", "/api/admin/users")).json();
  const owner = items.find((u: { username: string }) => u.username === "owner");
  const member = items.find((u: { username: string }) => u.username === "member");

  assert.equal((await admin("PATCH", `/api/admin/users/${owner.id}`, { isAdmin: false })).json().error, "last_admin");
  assert.equal((await admin("DELETE", `/api/admin/users/${owner.id}`)).json().error, "cannot_delete_self");

  const created = await admin("POST", "/api/admin/users", { username: "newbie", password: "newbie-password" });
  assert.equal(created.statusCode, 201);
  assert.equal((await admin("POST", "/api/admin/users", { username: "newbie", password: "newbie-password" })).statusCode, 409);

  assert.equal((await admin("PATCH", `/api/admin/users/${member.id}`, { isAdmin: true })).statusCode, 200);
  assert.equal((await admin("PATCH", `/api/admin/users/${member.id}`, { password: "a-new-password" })).statusCode, 200);
  assert.ok(await login("member", "a-new-password"));
  assert.equal((await admin("DELETE", `/api/admin/users/${member.id}`)).statusCode, 204);
  await close();
});

test("sign-up mode changes take effect live", async () => {
  const { app, login, as, close } = await setup();
  const admin = as(await login("owner", "owner-password"));
  const health = async () => (await app.inject({ method: "GET", url: "/api/health" })).json().auth.signup;
  assert.equal(await health(), "closed");
  const res = (await admin("PUT", "/api/admin/signup", { mode: "invite" })).json();
  assert.equal(res.mode, "invite");
  assert.ok(res.inviteCode);
  assert.equal(await health(), "invite");
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "friend", password: "friend-password", inviteCode: res.inviteCode } });
  assert.ok(reg.statusCode < 300, reg.body);
  await admin("PUT", "/api/admin/signup", { mode: "closed" });
  assert.equal(await health(), "closed");
  await close();
});
