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
import { openDb } from "../db.js";
import { buildDjMessages, createProvider, parseTextRequest, type FetchFn } from "./core/index.js";
import { generateText, tidyLine } from "./chat.js";
import { createLlmPlugin } from "./plugin.js";

const sseResponse = (events: string[]) =>
  new Response(events.map((e) => `data: ${e}\n\n`).join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });

/** A fetch that answers every call with `make()` and records the request bodies. */
function fetchReturning(make: () => Response): { fetchImpl: FetchFn; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(init?.body ? JSON.parse(String(init.body)) : {});
    return make();
  }) as FetchFn;
  return { fetchImpl, bodies };
}

const MESSAGES = [
  { role: "system" as const, content: "be brief" },
  { role: "user" as const, content: "hi" },
];

test("parseTextRequest validates and bounds chat requests", () => {
  assert.deepEqual(parseTextRequest({ messages: MESSAGES, temperature: 9, extra: 1 }), { messages: MESSAGES, temperature: 2 });
  for (const bad of [
    null,
    { messages: [] },
    { messages: [{ role: "tool", content: "x" }] },
    { messages: [{ role: "user", content: 3 }] },
    { messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }] },
    { messages: [{ role: "user", content: "x".repeat(32_001) }] },
    { messages: Array.from({ length: 31 }, () => MESSAGES[1]) },
  ]) {
    assert.throws(() => parseTextRequest(bad), /LLM request|too large/);
  }
});

test("tidyLine flattens control characters and bounds length", () => {
  assert.equal(tidyLine("  a\n\n\tb  ", 20), "a b");
  assert.equal(tidyLine("x".repeat(50), 10), "xxxxxxxxxx");
});

test("OpenAI-compatible chatText streams deltas and sends stream:true", async () => {
  const { fetchImpl, bodies } = fetchReturning(() =>
    sseResponse([
      JSON.stringify({ choices: [{ delta: { role: "assistant" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }),
      "not json at all",
      JSON.stringify({ choices: [{ delta: { content: "lo" } }] }),
      "[DONE]",
    ]),
  );
  const p = createProvider({ kind: "openai-compatible", baseUrl: "http://x/v1", model: "m" }, fetchImpl);
  const seen: string[] = [];
  const text = await p.chatText!({ messages: MESSAGES }, { onDelta: (d) => seen.push(d) });
  assert.equal(text, "Hello");
  assert.deepEqual(seen, ["Hel", "lo"]);
  assert.equal(bodies[0].stream, true);
});

test("OpenAI-compatible chatText accepts a server that ignores stream:true", async () => {
  const { fetchImpl } = fetchReturning(
    () => new Response(JSON.stringify({ choices: [{ message: { content: "all at once" } }] }), { headers: { "Content-Type": "application/json" } }),
  );
  const p = createProvider({ kind: "openai-compatible", baseUrl: "http://x/v1", model: "m" }, fetchImpl);
  const seen: string[] = [];
  assert.equal(await p.chatText!({ messages: MESSAGES }, { onDelta: (d) => seen.push(d) }), "all at once");
  assert.deepEqual(seen, ["all at once"]);
});

test("chatText reports clear errors: bad key, missing model, empty reply, refusal", async () => {
  const mk = (res: () => Response) =>
    createProvider({ kind: "openai-compatible", baseUrl: "http://x/v1", model: "gone" }, fetchReturning(res).fetchImpl);
  await assert.rejects(mk(() => new Response("no", { status: 401 })).chatText!({ messages: MESSAGES }), /rejected the API key/);
  await assert.rejects(mk(() => new Response("model not found", { status: 404 })).chatText!({ messages: MESSAGES }), /wasn't found/);
  await assert.rejects(mk(() => sseResponse(["[DONE]"])).chatText!({ messages: MESSAGES }), /empty reply/);
  await assert.rejects(
    mk(() => sseResponse([JSON.stringify({ choices: [{ delta: { refusal: "nope" } }] })])).chatText!({ messages: MESSAGES }),
    /refused: nope/,
  );
});

test("Ollama chatText reads newline-delimited JSON", async () => {
  const lines = [
    JSON.stringify({ message: { content: "Hi " }, done: false }),
    "",
    JSON.stringify({ message: { content: "there" }, done: false }),
    JSON.stringify({ message: { content: "" }, done: true }),
  ].join("\n");
  const { fetchImpl, bodies } = fetchReturning(() => new Response(lines));
  const p = createProvider({ kind: "ollama", baseUrl: "http://x", model: "llama3.2:3b" }, fetchImpl);
  assert.equal(await p.chatText!({ messages: MESSAGES }), "Hi there");
  assert.equal(bodies[0].stream, true);
  const failing = createProvider(
    { kind: "ollama", baseUrl: "http://x", model: "m" },
    fetchReturning(() => new Response(JSON.stringify({ error: "model requires more memory" }) + "\n")).fetchImpl,
  );
  await assert.rejects(failing.chatText!({ messages: MESSAGES }), /requires more memory/);
});

test("Anthropic chatText streams text deltas and sends the system prompt separately", async () => {
  const { fetchImpl, bodies } = fetchReturning(() =>
    sseResponse([
      JSON.stringify({ type: "message_start" }),
      JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Good " } }),
      JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "song." } }),
      JSON.stringify({ type: "message_stop" }),
    ]),
  );
  const p = createProvider({ kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "m", apiKey: "k" }, fetchImpl);
  assert.equal(await p.chatText!({ messages: MESSAGES }), "Good song.");
  assert.equal(bodies[0].system, "be brief");
  assert.deepEqual(bodies[0].messages, [{ role: "user", content: "hi" }]);
});

test("generateText falls back to a { reply } JSON object for providers without text chat", async () => {
  const seen: string[] = [];
  const provider = {
    status: async () => ({ available: true, models: [] }),
    chatJson: async <T>() => ({ reply: " relayed answer " }) as T,
  };
  assert.equal(await generateText(provider, { messages: MESSAGES }, (d) => seen.push(d)), "relayed answer");
  assert.deepEqual(seen, ["relayed answer"]);
  await assert.rejects(generateText({ ...provider, chatJson: async <T>() => ({}) as T }, { messages: MESSAGES }), /empty reply/);
});

test("buildDjMessages includes the host style and the listener's reactions", () => {
  const profile = { topArtists: ["A"], genres: [], topTracks: [], recentTracks: [] };
  const prompt = buildDjMessages(profile, { style: "dry and witty", notes: ["Skipped quickly: X – Y"] })
    .map((m) => m.content)
    .join("\n");
  assert.match(prompt, /Host style for the intros.*dry and witty/);
  assert.match(prompt, /Skipped quickly: X – Y/);
  const plain = buildDjMessages(profile, {}).map((m) => m.content).join("\n");
  assert.doesNotMatch(plain, /Host style/);
});

// ---- the route ----------------------------------------------------------------

/** An OpenAI-style server: streams word by word when asked, answers JSON for schema requests. */
async function fakeLlm() {
  const seen: { body: Record<string, unknown> }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      seen.push({ body });
      const wantsFail = JSON.stringify(body.messages).includes("EXPLODE");
      if (wantsFail) {
        res.statusCode = 500;
        return res.end("secret upstream detail 10.0.0.9");
      }
      if (body.stream) {
        res.setHeader("Content-Type", "text/event-stream");
        for (const w of ["Nice ", "tune", "!"]) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "Mix", songs: [] }) } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, close: () => new Promise((r) => server.close(r)) };
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-chat-"));
  const db = openDb(":memory:");
  await createLocalUser(db, { username: "admin", password: "admin-password", isAdmin: true });
  await createLocalUser(db, { username: "alice", password: "alice-password" });
  const app = await buildApp({
    config: { host: "127.0.0.1", port: 0, dataDir: dir, musicDir: dir, scanIntervalMinutes: 0, trustProxy: false, logLevel: "silent" },
    db,
    secret: "s".repeat(64),
    logger: false,
    plugins: [createLlmPlugin()],
  });
  const signIn = async (username: string) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: `${username}-password` } });
    return { authorization: `Bearer ${(res.json() as AuthResponse).token}` };
  };
  return { app, admin: await signIn("admin"), alice: await signIn("alice") };
}

test("POST /api/llm/chat: text, JSON, streaming and errors", async () => {
  const llm = await fakeLlm();
  const { app, admin, alice } = await setup();
  const chat = (headers: Record<string, string> | undefined, payload: unknown) =>
    app.inject({ method: "POST", url: "/api/llm/chat", headers, payload: payload as object });

  assert.equal((await chat(undefined, { messages: MESSAGES })).statusCode, 401);
  process.env.LLM_CHAT_DISABLED = "1";
  assert.equal((await chat(alice, { messages: MESSAGES })).json().error, "chat_disabled");
  delete process.env.LLM_CHAT_DISABLED;
  assert.equal((await chat(alice, { messages: MESSAGES })).statusCode, 409, "no provider yet");

  await app.inject({
    method: "POST",
    url: "/api/admin/llm/providers",
    headers: admin,
    payload: { name: "Local", kind: "openai-compatible", baseUrl: llm.url, model: "tiny" },
  });

  const text = await chat(alice, { messages: MESSAGES });
  assert.equal(text.statusCode, 200);
  assert.deepEqual(text.json(), { text: "Nice tune!" });

  const json = await chat(alice, { messages: MESSAGES, schema: { type: "object" } });
  assert.deepEqual(json.json(), { data: { title: "Mix", songs: [] } });

  const streamed = await chat(alice, { messages: MESSAGES, stream: true });
  assert.equal(streamed.statusCode, 200);
  assert.match(String(streamed.headers["content-type"]), /text\/event-stream/);
  const events = streamed.body.split("\n\n").filter(Boolean);
  assert.deepEqual(events.slice(0, 3).map((e) => JSON.parse(e.split("data: ")[1]).text), ["Nice ", "tune", "!"]);
  assert.match(events[events.length - 1], /^event: done/);

  assert.equal((await chat(alice, { messages: [] })).statusCode, 400);
  assert.equal((await chat(alice, { messages: MESSAGES, schema: [] })).statusCode, 400);
  assert.equal((await chat(alice, { provider: "server:missing", messages: MESSAGES })).statusCode, 404);

  // Failures: ordinary users never see upstream text; admins do.
  const boom = [{ role: "user", content: "EXPLODE" }];
  const failed = await chat(alice, { messages: boom });
  assert.equal(failed.statusCode, 502);
  assert.ok(!failed.body.includes("10.0.0.9"));
  assert.match((await chat(admin, { messages: boom })).json().message, /10\.0\.0\.9/);
  const failedStream = await chat(alice, { messages: boom, stream: true });
  assert.match(failedStream.body, /event: error/);
  assert.ok(!failedStream.body.includes("10.0.0.9"));

  await llm.close();
  await app.close();
});

test("POST /api/dj/picks passes the host style and notes to the prompt", async () => {
  const llm = await fakeLlm();
  const { app, admin, alice } = await setup();
  await app.inject({
    method: "POST",
    url: "/api/admin/llm/providers",
    headers: admin,
    payload: { name: "Local", kind: "openai-compatible", baseUrl: llm.url, model: "tiny" },
  });
  await app.inject({
    method: "POST",
    url: "/api/dj/picks",
    headers: alice,
    payload: { profile: { topArtists: ["A"], genres: [], topTracks: [], recentTracks: [] }, style: "calm\nlate-night", notes: ["Skipped quickly: A – B"] },
  });
  const prompt = JSON.stringify(llm.seen[0].body.messages);
  assert.match(prompt, /Host style for the intros.*calm late-night/);
  assert.match(prompt, /Skipped quickly: A – B/);
  await llm.close();
  await app.close();
});
