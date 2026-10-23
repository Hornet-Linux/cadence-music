import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { AuthResponse } from "@uma/shared";
import { buildApp } from "../app.js";
import { createLocalUser } from "../auth/users.js";
import { openDb, type Db } from "../db.js";
import { createProvider, type FetchFn } from "./core/index.js";
import { createLlmPlugin, noRedirects } from "./plugin.js";
import { open, seal } from "./secretBox.js";
import { ProviderStore } from "./store.js";

const SECRET = "s".repeat(64);
const OLD_SECRET = "o".repeat(64);

test("a sealed key is bound to its provider id", () => {
  const sealed = seal("sk-1", SECRET, undefined, "provider-a");
  assert.match(sealed, /^v2\./);
  assert.equal(open(sealed, SECRET, undefined, "provider-a"), "sk-1");
  assert.equal(open(sealed, SECRET, undefined, "provider-b"), null, "copied onto another row, it doesn't open");
  assert.equal(open(sealed, SECRET), null);
  // Old unbound values still open, so existing databases keep working until re-sealed.
  assert.equal(open(seal("sk-old", SECRET), SECRET, undefined, "anything"), "sk-old");
});

test("a key swapped onto another provider in the database is refused", () => {
  const db = openDb(":memory:");
  const store = new ProviderStore(db, SECRET);
  const a = store.create({ name: "A", kind: "openai-compatible", baseUrl: "https://a.example/v1", model: "m", apiKey: "sk-a" });
  const b = store.create({ name: "B", kind: "openai-compatible", baseUrl: "https://evil.example/v1", model: "m", apiKey: "sk-b" });
  const { api_key_enc } = db.prepare("SELECT api_key_enc FROM llm_providers WHERE id = ?").get(a.id) as { api_key_enc: string };
  db.prepare("UPDATE llm_providers SET api_key_enc = ? WHERE id = ?").run(api_key_enc, b.id);
  assert.equal(store.config(b.id), null, "never called without its own key");
  assert.equal(store.get(b.id)?.keyUnreadable, true);
  assert.equal(store.config(a.id)?.apiKey, "sk-a");
});

function legacyRow(db: Db, id: string, secret: string, key: string) {
  db.prepare(
    `INSERT INTO llm_providers (id, name, kind, base_url, model, api_key_enc, enabled, is_default, created_at, updated_at)
     VALUES (?, 'Old', 'openai-compatible', 'https://a.example/v1', 'm', ?, 1, 1, 1, 1)`,
  ).run(id, seal(key, secret));
}

test("rotating SERVER_SECRET: keys sealed with the previous secret are re-sealed on start", () => {
  const db = openDb(":memory:");
  legacyRow(db, "old1", OLD_SECRET, "sk-legacy");
  assert.equal(new ProviderStore(db, SECRET).config("old1"), null, "without the previous secret the key is unreadable");
  assert.deepEqual(new ProviderStore(db, SECRET).migrateKeys(), { resealed: 0, unreadable: ["old1"] });

  const store = new ProviderStore(db, SECRET, [OLD_SECRET]);
  assert.deepEqual(store.migrateKeys(), { resealed: 1, unreadable: [] });
  // Now readable with the new secret alone, and bound to its id.
  const after = new ProviderStore(db, SECRET);
  assert.equal(after.config("old1")?.apiKey, "sk-legacy");
  assert.deepEqual(after.migrateKeys(), { resealed: 0, unreadable: [] });
});

test("server providers don't follow redirects", async () => {
  const target = http.createServer((_req, res) => res.end(JSON.stringify({ models: [{ name: "secret-model" }] })));
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  const redirector = http.createServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/api/tags` });
    res.end();
  });
  await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
  try {
    const baseUrl = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}`;
    const followed = await createProvider({ kind: "ollama", baseUrl, model: "m" }).status();
    assert.equal(followed.available, true, "plain fetch follows the redirect");
    const status = await createProvider({ kind: "ollama", baseUrl, model: "m" }, noRedirects()).status();
    assert.equal(status.available, false);
    assert.deepEqual(status.models, []);
  } finally {
    redirector.close();
    target.close();
  }
});

async function setup(db: Db, fetchFn: FetchFn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-llm-hard-"));
  const app = await buildApp({
    config: { host: "127.0.0.1", port: 0, dataDir: dir, musicDir: dir, scanIntervalMinutes: 0, trustProxy: false, logLevel: "silent" },
    db,
    secret: SECRET,
    logger: false,
    plugins: [createLlmPlugin({ fetchFn })],
  });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "alice", password: "alice-password" } });
  return { app, headers: { authorization: `Bearer ${(login.json() as AuthResponse).token}` } };
}

const fakeOllama: FetchFn = async (input) => {
  if (String(input).endsWith("/api/tags")) return Response.json({ models: [{ name: "m" }] });
  return Response.json({ message: { content: JSON.stringify({ picks: [{ artist: "A", title: "B", intro: "" }] }) } });
};

test("status checks are rate limited for listeners", async () => {
  const db = openDb(":memory:");
  await createLocalUser(db, { username: "alice", password: "alice-password" });
  new ProviderStore(db, SECRET).create({ name: "P", kind: "ollama", baseUrl: "http://ollama:11434", model: "m" });
  const { app, headers } = await setup(db, fakeOllama);
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await app.inject({ method: "POST", url: "/api/llm/status", headers, payload: {} })).statusCode;
  assert.equal(last, 429);
  await app.close();
});

test("the DJ allowance survives a restart", async () => {
  const db = openDb(":memory:");
  await createLocalUser(db, { username: "alice", password: "alice-password" });
  new ProviderStore(db, SECRET).create({ name: "P", kind: "ollama", baseUrl: "http://ollama:11434", model: "m" });
  const body = { profile: { topArtists: ["A"], genres: [], topTracks: [], recentTracks: [] } };
  const first = await setup(db, fakeOllama);
  for (let i = 0; i < 20; i++) {
    assert.equal((await first.app.inject({ method: "POST", url: "/api/dj/picks", headers: first.headers, payload: body })).statusCode, 200);
  }
  await first.app.close();
  const second = await setup(db, fakeOllama);
  const res = await second.app.inject({ method: "POST", url: "/api/dj/picks", headers: second.headers, payload: body });
  assert.equal(res.statusCode, 429);
  await second.app.close();
});
