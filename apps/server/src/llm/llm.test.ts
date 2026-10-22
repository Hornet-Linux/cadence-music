import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { AuthResponse, DjPicksResponse, LlmProvidersResponse, LlmRelayJob } from "@uma/shared";
import { buildApp } from "../app.js";
import { createLocalUser } from "../auth/users.js";
import { openDb } from "../db.js";
import { createLlmPlugin } from "./plugin.js";

const PROFILE = { topArtists: ["Daft Punk"], genres: ["house"], topTracks: [], recentTracks: [] };

/** An OpenAI-style server that records requests and answers with two picks. */
async function fakeLlm() {
  const seen: { auth?: string; body: { messages: { content: string }[] } }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "tiny" }] }));
      seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      const picks = [
        { artist: "Justice", title: "D.A.N.C.E.", intro: "Here we go." },
        { artist: "", title: "junk", intro: "" },
      ];
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ picks }) } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { url, seen, close: () => new Promise((r) => server.close(r)) };
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-llm-"));
  const db = openDb(":memory:");
  createLocalUser(db, { username: "admin", password: "admin-password", isAdmin: true });
  createLocalUser(db, { username: "alice", password: "alice-password" });
  createLocalUser(db, { username: "bob", password: "bob-password" });
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
  return { app, db, admin: await signIn("admin"), alice: await signIn("alice"), bob: await signIn("bob") };
}

test("server providers: admin-only, key stored encrypted and never returned", async () => {
  const llm = await fakeLlm();
  const { app, db, admin, alice } = await setup();
  const input = { name: "Local", kind: "openai-compatible", baseUrl: llm.url, model: "tiny", apiKey: "sk-super-secret" };

  assert.equal((await app.inject({ method: "POST", url: "/api/admin/llm/providers", payload: input })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/llm/providers", headers: alice, payload: input })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/llm/providers", headers: admin, payload: { ...input, baseUrl: "ftp://x" } })).statusCode, 400);

  const created = await app.inject({ method: "POST", url: "/api/admin/llm/providers", headers: admin, payload: input });
  assert.equal(created.statusCode, 201);
  const provider = created.json();
  assert.equal(provider.hasKey, true);
  assert.equal(provider.isDefault, true, "the first provider becomes the default");
  assert.ok(!created.body.includes("sk-super-secret"));

  const adminList = await app.inject({ method: "GET", url: "/api/admin/llm/providers", headers: admin });
  assert.ok(!adminList.body.includes("sk-super-secret"));
  const stored = db.prepare("SELECT api_key_enc FROM llm_providers").get() as { api_key_enc: string };
  assert.ok(!stored.api_key_enc.includes("sk-super-secret"), "encrypted at rest");

  // Ordinary users see a name and model, not the URL or key.
  const visible = await app.inject({ method: "GET", url: "/api/llm/providers", headers: alice });
  assert.ok(!visible.body.includes("sk-super-secret") && !visible.body.includes(llm.url));
  assert.deepEqual((visible.json() as LlmProvidersResponse).items.map((i) => [i.ref, i.scope, i.isDefault]), [
    [`server:${provider.id}`, "server", true],
  ]);

  // Editing without a key keeps the saved one; the test endpoint can reuse it.
  const edited = await app.inject({
    method: "PUT",
    url: `/api/admin/llm/providers/${provider.id}`,
    headers: admin,
    payload: { ...input, apiKey: undefined, name: "Renamed" },
  });
  assert.equal(edited.json().hasKey, true);
  const test = await app.inject({
    method: "POST",
    url: "/api/admin/llm/test",
    headers: admin,
    payload: { id: provider.id, kind: input.kind, baseUrl: input.baseUrl, model: "tiny" },
  });
  assert.deepEqual(test.json(), { available: true, models: ["tiny"] });

  assert.equal((await app.inject({ method: "DELETE", url: `/api/admin/llm/providers/${provider.id}`, headers: admin })).statusCode, 204);
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/llm/providers", headers: alice })).json(), { items: [] });
  await llm.close();
  await app.close();
});

test("AI DJ: the server calls the provider with its own key and returns clean picks", async () => {
  const llm = await fakeLlm();
  const { app, admin, alice } = await setup();
  const post = (headers: Record<string, string> | undefined, payload: unknown) =>
    app.inject({ method: "POST", url: "/api/dj/picks", headers, payload: payload as object });

  assert.equal((await post(undefined, { profile: PROFILE })).statusCode, 401);
  assert.equal((await post(alice, { profile: PROFILE })).statusCode, 409, "no provider yet");

  await app.inject({
    method: "POST",
    url: "/api/admin/llm/providers",
    headers: admin,
    payload: { name: "Local", kind: "openai-compatible", baseUrl: llm.url, model: "tiny", apiKey: "sk-server-key" },
  });

  const res = await post(alice, { profile: PROFILE, mood: "late night drive", avoid: ["A – B"], count: 2 });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.json() as DjPicksResponse).picks, [{ artist: "Justice", title: "D.A.N.C.E.", intro: "Here we go." }]);
  assert.equal(llm.seen[0].auth, "Bearer sk-server-key");
  const prompt = llm.seen[0].body.messages.map((m) => m.content).join("\n");
  assert.match(prompt, /Daft Punk/);
  assert.match(prompt, /late night drive/);
  assert.match(prompt, /Pick 2 songs/);

  assert.equal((await post(alice, { profile: "nope" })).statusCode, 400);
  assert.equal((await post(alice, { provider: "server:missing", profile: PROFILE })).statusCode, 404);
  assert.equal((await post(alice, { provider: "device:abcdefgh:x", profile: PROFILE })).statusCode, 404);
  await llm.close();
  await app.close();
});

test("AI DJ: provider failures come back as a readable 502", async () => {
  const { app, admin, alice } = await setup();
  await app.inject({
    method: "POST",
    url: "/api/admin/llm/providers",
    headers: admin,
    payload: { name: "Dead", kind: "ollama", baseUrl: "http://127.0.0.1:9", model: "m" },
  });
  const res = await app.inject({ method: "POST", url: "/api/dj/picks", headers: alice, payload: { profile: PROFILE } });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, "llm_failed");
  assert.match(res.json().message, /Couldn't reach Ollama/);
  await app.close();
});

test("device relay: another device uses a provider on a person's computer, and nobody else can", async () => {
  const { app, alice, bob } = await setup();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const registration = {
    deviceId: "desktop-1234",
    name: "Desktop",
    providers: [{ id: "ollama", name: "Ollama", kind: "ollama", model: "llama3.2:3b" }],
  };

  // The desktop connects and listens for jobs.
  const abort = new AbortController();
  const stream = await fetch(`${base}/api/llm/devices/connect`, {
    method: "POST",
    headers: { ...alice, "Content-Type": "application/json" },
    body: JSON.stringify(registration),
    signal: abort.signal,
  });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const nextJob = async (): Promise<LlmRelayJob> => {
    for (;;) {
      const m = /event: job\ndata: (.*)\n\n/.exec(buffer);
      if (m) {
        buffer = buffer.slice(buffer.indexOf(m[0]) + m[0].length);
        return JSON.parse(m[1]) as LlmRelayJob;
      }
      const { value, done } = await reader.read();
      assert.ok(!done, "stream ended early");
      buffer += decoder.decode(value);
    }
  };
  const ref = "device:desktop-1234:ollama";
  const asAlice = { ...alice, "Content-Type": "application/json" };
  const picksVia = (headers: Record<string, string>) =>
    fetch(`${base}/api/dj/picks`, { method: "POST", headers, body: JSON.stringify({ provider: ref, profile: PROFILE }) });
  const answer = (headers: Record<string, string>, jobId: string, result: unknown) =>
    fetch(`${base}/api/llm/devices/jobs/${jobId}`, { method: "POST", headers, body: JSON.stringify(result) });

  // Alice's other devices see it, with no key or URL; Bob sees nothing and can't use it.
  const listed = (await app.inject({ method: "GET", url: "/api/llm/providers", headers: alice })).json() as LlmProvidersResponse;
  assert.deepEqual(listed.items, [
    { ref, name: "Ollama", kind: "ollama", model: "llama3.2:3b", scope: "device", deviceName: "Desktop" },
  ]);
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/llm/providers", headers: bob })).json(), { items: [] });
  assert.equal((await picksVia({ ...bob, "Content-Type": "application/json" })).status, 404);

  // A DJ request on the phone becomes a job on the desktop.
  const pending = picksVia(asAlice);
  const job = await nextJob();
  assert.equal(job.op, "chat-json");
  assert.equal(job.providerId, "ollama");
  assert.match(job.request!.messages.map((m) => m.content).join("\n"), /Daft Punk/);

  // Another person can't answer Alice's job.
  const steal = await answer({ ...bob, "Content-Type": "application/json" }, job.jobId, { ok: true, data: { picks: [] } });
  assert.equal(steal.status, 404);

  const reply = { picks: [{ artist: "Justice", title: "D.A.N.C.E.", intro: "hi" }] };
  assert.equal((await answer(asAlice, job.jobId, { ok: true, data: reply })).status, 204);
  const done = await pending;
  assert.equal(done.status, 200);
  assert.deepEqual(((await done.json()) as DjPicksResponse).picks, reply.picks);

  // When the computer's provider fails, the phone gets its message.
  const failing = picksVia(asAlice);
  const job2 = await nextJob();
  await answer(asAlice, job2.jobId, { ok: false, error: "Ollama isn't running" });
  const failed = await failing;
  assert.equal(failed.status, 502);
  assert.equal(((await failed.json()) as { message: string }).message, "Ollama isn't running");

  // Closing the desktop app takes its providers away and fails anything in flight.
  const inFlight = picksVia(asAlice);
  await nextJob();
  abort.abort();
  assert.equal((await inFlight).status, 502);
  for (let i = 0; i < 20; i++) {
    const now = (await app.inject({ method: "GET", url: "/api/llm/providers", headers: alice })).json() as LlmProvidersResponse;
    if (now.items.length === 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/llm/providers", headers: alice })).json(), { items: [] });
  await app.close();
});
