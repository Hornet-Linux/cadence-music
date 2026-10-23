import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthResponse, LlmProvidersResponse } from "@uma/shared";
import { buildApp } from "../app.js";
import { createLocalUser } from "../auth/users.js";
import { parseOllama } from "../config.js";
import { openDb } from "../db.js";
import { BUNDLED_NAME, ensureBundledProvider, pullModelInBackground } from "./bundled.js";
import type { FetchFn } from "./core/index.js";
import { createLlmPlugin } from "./plugin.js";
import { ProviderStore } from "./store.js";

const silent = { info() {}, warn() {} } as unknown as Parameters<typeof pullModelInBackground>[2];

test("OLLAMA_URL: plain http(s) only, default model", () => {
  assert.equal(parseOllama({}), undefined);
  assert.deepEqual(parseOllama({ OLLAMA_URL: "http://ollama:11434/" }), { url: "http://ollama:11434", model: "llama3.2:3b" });
  assert.deepEqual(parseOllama({ OLLAMA_URL: "http://ollama:11434", OLLAMA_MODEL: "qwen3:8b" }), {
    url: "http://ollama:11434",
    model: "qwen3:8b",
  });
  assert.throws(() => parseOllama({ OLLAMA_URL: "ftp://ollama" }));
  assert.throws(() => parseOllama({ OLLAMA_URL: "http://u:p@ollama:11434" }));
  assert.throws(() => parseOllama({ OLLAMA_URL: "http://ollama:11434", OLLAMA_MODEL: "a b; rm" }));
});

test("the server's Ollama is registered once and becomes the default only if there is none", () => {
  const db = openDb(":memory:");
  const store = new ProviderStore(db, "s".repeat(64));
  const other = store.create({ name: "Cloud", kind: "openai-compatible", baseUrl: "https://api.example.com/v1", model: "m" });
  const id = ensureBundledProvider(store, { url: "http://ollama:11434", model: "llama3.2:3b" });
  assert.equal(ensureBundledProvider(store, { url: "http://ollama:11434", model: "other" }), id);
  const saved = store.get(id)!;
  assert.equal(saved.name, BUNDLED_NAME);
  assert.equal(saved.model, "llama3.2:3b");
  assert.equal(saved.isDefault, false);
  assert.equal(store.get(other.id)!.isDefault, true);

  const fresh = new ProviderStore(openDb(":memory:"), "s".repeat(64));
  const first = ensureBundledProvider(fresh, { url: "http://ollama:11434", model: "m" });
  assert.equal(fresh.get(first)!.isDefault, true);
});

const ndjson = (...events: object[]) => new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n");

function fakeOllama(installed: string[], opts: { failFirst?: number; pullError?: string } = {}) {
  const calls: string[] = [];
  let failures = opts.failFirst ?? 0;
  const fetchFn: FetchFn = async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (failures > 0) {
      failures--;
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }
    if (url.endsWith("/api/tags")) return Response.json({ models: installed.map((name) => ({ name })) });
    if (url.endsWith("/api/pull")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.stream, true, "a streamed pull, so fetch doesn't time out waiting for headers");
      if (opts.pullError) return ndjson({ status: "pulling manifest" }, { error: opts.pullError });
      installed.push(body.model);
      return ndjson({ status: "pulling manifest" }, { status: "pulling abc", total: 100, completed: 50 }, { status: "success" });
    }
    if (url.endsWith("/api/generate")) return Response.json({ done: true });
    return new Response("not found", { status: 404 });
  };
  return { calls, fetchFn };
}

test("the model is downloaded only when missing, after Ollama comes up", async () => {
  const signal = new AbortController().signal;
  const present = fakeOllama(["llama3.2:3b"]);
  assert.equal(await pullModelInBackground("http://ollama:11434", "llama3.2:3b", silent, signal, present.fetchFn), "present");
  assert.deepEqual(present.calls, ["GET /api/tags", "POST /api/generate"], "preloads the model");

  const missing = fakeOllama([], { failFirst: 2 });
  const result = await pullModelInBackground("http://ollama:11434", "qwen3:8b", silent, signal, missing.fetchFn, { retryMs: 1 });
  assert.equal(result, "pulled");
  assert.deepEqual(missing.calls, ["GET /api/tags", "GET /api/tags", "GET /api/tags", "POST /api/pull", "POST /api/generate"]);

  const broken = fakeOllama([], { pullError: "pull model manifest: file does not exist" });
  assert.equal(await pullModelInBackground("http://ollama:11434", "nope", silent, signal, broken.fetchFn, { retryMs: 1 }), "failed");
  assert.equal(broken.calls.filter((c) => c === "POST /api/pull").length, 3, "retried");

  const down = fakeOllama([], { failFirst: 1000 });
  assert.equal(
    await pullModelInBackground("http://ollama:11434", "m", silent, signal, down.fetchFn, { waitMs: 20, retryMs: 5 }),
    "unreachable",
  );
});

test("with OLLAMA_URL, apps see the server's Ollama as the default provider", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-ollama-"));
  const db = openDb(":memory:");
  await createLocalUser(db, { username: "alice", password: "alice-password" });
  const ollama = fakeOllama(["llama3.2:3b"]);
  const app = await buildApp({
    config: {
      host: "127.0.0.1",
      port: 0,
      dataDir: dir,
      musicDir: dir,
      scanIntervalMinutes: 0,
      trustProxy: false,
      logLevel: "silent",
      ollama: { url: "http://ollama:11434", model: "llama3.2:3b" },
    },
    db,
    secret: "s".repeat(64),
    logger: false,
    plugins: [createLlmPlugin({ fetchFn: ollama.fetchFn })],
  });
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "alice", password: "alice-password" } });
  const headers = { authorization: `Bearer ${(login.json() as AuthResponse).token}` };
  const res = await app.inject({ method: "GET", url: "/api/llm/providers", headers });
  const items = (res.json() as LlmProvidersResponse).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].scope, "server");
  assert.equal(items[0].name, BUNDLED_NAME);
  assert.equal(items[0].isDefault, true);
  await app.close();
});
