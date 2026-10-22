import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDjMessages, cleanReply, createProvider, extractJson, parseJsonRequest, parseProviderConfig, type FetchFn } from "./core/index.js";
import { endpoint } from "./core/http.js";
import { open, seal } from "./secretBox.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

/** A fetch that answers from a queue and records what it was asked. */
function fakeFetch(...replies: (Response | Error)[]): { fetchImpl: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, body: init?.body ? JSON.parse(String(init.body)) : {} });
    const next = replies.shift();
    if (!next) throw new Error("no reply queued");
    if (next instanceof Error) throw next;
    return next;
  }) as FetchFn;
  return { fetchImpl, calls };
}

const REQ = {
  messages: [
    { role: "system" as const, content: "be a DJ" },
    { role: "user" as const, content: "pick songs" },
  ],
  schema: { type: "object", properties: { picks: { type: "array" } } },
};

test("parseJsonRequest validates requests that cross a trust boundary", () => {
  const ok = parseJsonRequest({ ...REQ, temperature: 9, extra: "dropped" });
  assert.deepEqual(ok, { messages: REQ.messages, schema: REQ.schema, temperature: 2 });
  for (const bad of [
    null,
    { ...REQ, messages: [] },
    { ...REQ, messages: [{ role: "tool", content: "x" }] },
    { ...REQ, messages: [{ role: "user", content: 5 }] },
    { ...REQ, messages: Array.from({ length: 21 }, () => REQ.messages[1]) },
    { ...REQ, messages: [{ role: "user", content: "x".repeat(100_001) }] },
    { ...REQ, schema: null },
    { ...REQ, schema: [] },
  ]) {
    assert.throws(() => parseJsonRequest(bad), /LLM request|too large/);
  }
});

test("extractJson copes with fences and chatter", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('Sure! Here you go: {"a":3} Enjoy.'), { a: 3 });
  assert.throws(() => extractJson("no json here"), /valid JSON/);
});

test("endpoint keeps a /v1 prefix and rejects non-http URLs", () => {
  assert.equal(endpoint("http://localhost:1234/v1", "chat/completions"), "http://localhost:1234/v1/chat/completions");
  assert.equal(endpoint("http://localhost:1234/v1/", "/models"), "http://localhost:1234/v1/models");
  assert.equal(endpoint("http://localhost:11434", "api/tags"), "http://localhost:11434/api/tags");
  assert.throws(() => endpoint("file:///etc/passwd", "x"), /http/);
  assert.throws(() => endpoint("not a url", "x"), /valid URL/);
});

test("parseProviderConfig validates what crosses a trust boundary", () => {
  assert.deepEqual(parseProviderConfig({ kind: "ollama", baseUrl: " http://localhost:11434 ", model: " m " }), {
    kind: "ollama",
    baseUrl: "http://localhost:11434",
    model: "m",
  });
  assert.throws(() => parseProviderConfig({ kind: "nope", baseUrl: "http://x", model: "m" }));
  assert.throws(() => parseProviderConfig({ kind: "ollama", baseUrl: "ftp://x", model: "m" }));
  assert.throws(() => parseProviderConfig(null));
});

test("OpenAI-compatible: sends a JSON schema and the bearer key, and lists models", async () => {
  const { fetchImpl, calls } = fakeFetch(
    json({ choices: [{ message: { content: '{"picks":[]}' } }] }),
    json({ data: [{ id: "b" }, { id: "a" }] }),
  );
  const p = createProvider({ kind: "openai-compatible", baseUrl: "https://api.example.com/v1", model: "m", apiKey: "sk-1" }, fetchImpl);
  assert.deepEqual(await p.chatJson(REQ), { picks: [] });
  assert.equal(calls[0].url, "https://api.example.com/v1/chat/completions");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer sk-1");
  assert.equal((calls[0].body.response_format as { type: string }).type, "json_schema");
  assert.deepEqual(await p.status(), { available: true, models: ["a", "b"] });
});

test("OpenAI-compatible: steps down when the server rejects response_format, and remembers", async () => {
  const { fetchImpl, calls } = fakeFetch(
    json({ error: "response_format unsupported" }, 400),
    json({ error: "json_object unsupported" }, 400),
    json({ choices: [{ message: { content: 'Here: {"picks":[{"artist":"A","title":"T","intro":"i"}]}' } }] }),
    json({ choices: [{ message: { content: '{"picks":[]}' } }] }),
  );
  const p = createProvider({ kind: "openai-compatible", baseUrl: "http://localhost:1234/v1", model: "m" }, fetchImpl);
  assert.deepEqual(await p.chatJson(REQ), { picks: [{ artist: "A", title: "T", intro: "i" }] });
  assert.equal((calls[1].body.response_format as { type: string }).type, "json_object");
  assert.equal(calls[2].body.response_format, undefined);
  assert.match(String((calls[2].body.messages as { content: string }[])[0].content), /JSON Schema/);

  await p.chatJson(REQ); // second call goes straight to the mode that worked
  assert.equal(calls.length, 4);
  assert.equal(calls[3].body.response_format, undefined);
});

test("OpenAI-compatible: clear errors for bad keys, missing models and unreachable servers", async () => {
  const p = (r: Response | Error) =>
    createProvider({ kind: "openai-compatible", baseUrl: "http://x/v1", model: "gone" }, fakeFetch(r).fetchImpl);
  await assert.rejects(p(json({}, 401)).chatJson(REQ), /API key/);
  await assert.rejects(p(json({ error: "model not found" }, 404)).chatJson(REQ), /"gone" wasn't found/);
  await assert.rejects(p(new TypeError("fetch failed")).chatJson(REQ), /Couldn't reach/);
  assert.equal((await p(json({}, 401)).status()).available, false);
});

test("OpenAI-compatible: leaves out temperature for reasoning models", async () => {
  const { fetchImpl, calls } = fakeFetch(json({ choices: [{ message: { content: "{}" } }] }));
  await createProvider({ kind: "openai-compatible", baseUrl: "http://x/v1", model: "o3-mini" }, fetchImpl).chatJson(REQ);
  assert.equal("temperature" in calls[0].body, false);
});

test("Ollama: structured output, no-think for reasoning models, helpful missing-model error", async () => {
  const { fetchImpl, calls } = fakeFetch(json({ message: { content: '{"picks":[]}' } }), json({ error: "model 'x' not found" }, 404));
  const think = createProvider({ kind: "ollama", baseUrl: "http://localhost:11434", model: "qwen3:8b" }, fetchImpl);
  assert.deepEqual(await think.chatJson(REQ), { picks: [] });
  assert.equal(calls[0].url, "http://localhost:11434/api/chat");
  assert.deepEqual(calls[0].body.format, REQ.schema);
  assert.equal(calls[0].body.think, false);
  await assert.rejects(think.chatJson(REQ), /ollama pull qwen3:8b/);

  const plain = fakeFetch(json({ message: { content: "{}" } }));
  await createProvider({ kind: "ollama", baseUrl: "http://localhost:11434", model: "llama3.2:3b" }, plain.fetchImpl).chatJson(REQ);
  assert.equal("think" in plain.calls[0].body, false);
});

test("Anthropic: system prompt is separate and the reply comes from a forced tool call", async () => {
  const { fetchImpl, calls } = fakeFetch(json({ content: [{ type: "tool_use", input: { picks: [] } }] }));
  const p = createProvider({ kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-x", apiKey: "k" }, fetchImpl);
  assert.deepEqual(await p.chatJson(REQ), { picks: [] });
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal((calls[0].init.headers as Record<string, string>)["x-api-key"], "k");
  assert.equal(calls[0].body.system, "be a DJ");
  assert.deepEqual(calls[0].body.messages, [{ role: "user", content: "pick songs" }]);
  assert.deepEqual(calls[0].body.tool_choice, { type: "tool", name: "reply" });
});

test("DJ prompt and reply cleaning", () => {
  const messages = buildDjMessages(
    { topArtists: ["Daft Punk"], genres: [], topTracks: [], recentTracks: [] },
    { mood: "rainy", avoid: ["A – B"], count: 5, now: new Date(2025, 0, 1, 9) },
  );
  assert.match(messages[1].content, /Daft Punk/);
  assert.match(messages[1].content, /It's morning/);
  assert.match(messages[1].content, /Pick 5 songs/);
  assert.deepEqual(cleanReply({ picks: [{ artist: " A ", title: "T" }, { artist: "", title: "x" }, null] }), [
    { artist: "A", title: "T", intro: "" },
  ]);
  assert.deepEqual(cleanReply("nope"), []);

  // Bounded: at most 25 picks, short fields, no control characters.
  const many = Array.from({ length: 40 }, (_, i) => ({ artist: `A${i}`, title: "T", intro: "" }));
  assert.equal(cleanReply({ picks: many }).length, 25);
  const [long] = cleanReply({ picks: [{ artist: "a".repeat(500), title: "t".repeat(500), intro: "i".repeat(900) }] });
  assert.deepEqual([long.artist.length, long.title.length, long.intro.length], [200, 200, 400]);
  assert.deepEqual(cleanReply({ picks: [{ artist: "A\u0000\u001b[31m\nB", title: "T\u0007", intro: "x\ry\u0085z" }] }), [
    { artist: "A [31m B", title: "T", intro: "x y z" },
  ]);
  assert.deepEqual(cleanReply({ picks: [{ artist: "\u0000", title: "T" }] }), [], "empty after cleaning is dropped");
});

test("sealed API keys round-trip and only open with the same secret", () => {
  const sealed = seal("sk-secret-value", "server-secret");
  assert.ok(!sealed.includes("sk-secret-value"));
  assert.equal(open(sealed, "server-secret"), "sk-secret-value");
  assert.equal(open(sealed, "another-secret"), null);
  assert.equal(open("garbage", "server-secret"), null);
  assert.notEqual(seal("x", "s"), seal("x", "s"), "random IV");
});
