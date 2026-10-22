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
import { LlmError } from "./core/index.js";
import { createLlmPlugin, publicMessage } from "./plugin.js";

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
  await createLocalUser(db, { username: "admin", password: "admin-password", isAdmin: true });
  await createLocalUser(db, { username: "alice", password: "alice-password" });
  await createLocalUser(db, { username: "bob", password: "bob-password" });
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

test("AI DJ: provider failures come back as a safe 502", async () => {
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
  assert.match(res.json().message, /couldn't be reached/);
  assert.ok(!res.body.includes("127.0.0.1") && !res.body.includes("ECONNREFUSED"), "no network detail for ordinary users");
  // The admin who set it up still sees what went wrong.
  const asAdmin = await app.inject({ method: "POST", url: "/api/dj/picks", headers: admin, payload: { profile: PROFILE } });
  assert.match(asAdmin.json().message, /Couldn't reach Ollama/);
  await app.close();
});

test("server provider failures never leak upstream text to ordinary users", async () => {
  const upstream = { status: 500, body: "internal: db password is hunter2 at 10.0.0.5" };
  const fetchFn = (async (url: string | URL | Request) => {
    if (String(url).endsWith("/models")) return new Response("10.0.0.5 says no", { status: 503 });
    return new Response(upstream.body, { status: upstream.status });
  }) as typeof fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-llm-"));
  const db = openDb(":memory:");
  await createLocalUser(db, { username: "admin", password: "admin-password", isAdmin: true });
  await createLocalUser(db, { username: "alice", password: "alice-password" });
  const app = await buildApp({
    config: { host: "127.0.0.1", port: 0, dataDir: dir, musicDir: dir, scanIntervalMinutes: 0, trustProxy: false, logLevel: "silent" },
    db,
    secret: "s".repeat(64),
    logger: false,
    plugins: [createLlmPlugin({ fetchFn })],
  });
  const signIn = async (username: string) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: `${username}-password` } });
    return { authorization: `Bearer ${(res.json() as AuthResponse).token}` };
  };
  const admin = await signIn("admin");
  const alice = await signIn("alice");
  await app.inject({
    method: "POST",
    url: "/api/admin/llm/providers",
    headers: admin,
    payload: { name: "P", kind: "openai-compatible", baseUrl: "http://10.0.0.5:1234/v1", model: "m" },
  });
  const picks = (headers: Record<string, string>) =>
    app.inject({ method: "POST", url: "/api/dj/picks", headers, payload: { profile: PROFILE } });

  const asAlice = await picks(alice);
  assert.equal(asAlice.statusCode, 502);
  assert.equal(asAlice.json().message, "The AI provider failed. Ask the server owner to check it.");
  assert.ok(!asAlice.body.includes("hunter2") && !asAlice.body.includes("10.0.0.5"));
  assert.match((await picks(admin)).json().message, /hunter2/, "admins see the detail");

  const status = await app.inject({ method: "POST", url: "/api/llm/status", headers: alice, payload: {} });
  assert.ok(!status.body.includes("10.0.0.5") && !status.body.includes("503"));
  assert.equal(status.json().available, false);
  const adminStatus = await app.inject({ method: "POST", url: "/api/llm/status", headers: admin, payload: {} });
  assert.match(adminStatus.json().error, /503/);

  upstream.status = 401;
  assert.match((await picks(alice)).json().message, /rejected its API key/);
  upstream.status = 404;
  upstream.body = 'model "x" not found';
  assert.match((await picks(alice)).json().message, /doesn't have the configured model/);
  await app.close();
});

test("admin provider input is validated", async () => {
  const { app, admin } = await setup();
  const base = { name: "Local", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", model: "tiny" };
  const post = (payload: object) => app.inject({ method: "POST", url: "/api/admin/llm/providers", headers: admin, payload });
  const bad = [
    { ...base, baseUrl: "http://user:pass@127.0.0.1:1234/v1" },
    { ...base, baseUrl: "http://user@127.0.0.1:1234/v1" },
    { ...base, baseUrl: "http://127.0.0.1:1234/v1?key=abc" },
    { ...base, baseUrl: "http://127.0.0.1:1234/v1?" },
    { ...base, baseUrl: "http://127.0.0.1:1234/v1#frag" },
    { ...base, apiKey: "k".repeat(513) },
    { ...base, model: "m".repeat(201) },
    { ...base, name: "n".repeat(61) },
  ];
  for (const payload of bad) assert.equal((await post(payload)).statusCode, 400, JSON.stringify(payload).slice(0, 80));
  assert.equal((await post({ ...base, apiKey: "k".repeat(512), model: "m".repeat(200), name: "n".repeat(60) })).statusCode, 201);
  const test = await app.inject({
    method: "POST",
    url: "/api/admin/llm/test",
    headers: admin,
    payload: { ...base, baseUrl: "http://u:p@127.0.0.1:1/v1" },
  });
  assert.equal(test.statusCode, 400);
  await app.close();
});

test("device relay limits: devices per person and jobs per device", async () => {
  const { MAX_DEVICES_PER_USER, MAX_PENDING_PER_DEVICE, RelayHub } = await import("./relay.js");
  const hub = new RelayHub();
  const reg = (deviceId: string) => ({ deviceId, name: "D", providers: [{ id: "p", name: "P", kind: "ollama" as const, model: "m" }] });
  const closed: string[] = [];
  const sent: string[] = [];
  const detachers: (() => void)[] = [];
  for (let i = 0; i < MAX_DEVICES_PER_USER; i++) {
    const id = `device-${i}000`;
    detachers.push(hub.attach(1, reg(id), (j) => sent.push(j.jobId), () => closed.push(id))!);
  }
  assert.equal(hub.attach(1, reg("device-extra"), () => {}, () => {}), null, "one too many");
  assert.notEqual(hub.attach(2, reg("device-extra"), () => {}, () => {}), null, "other people have their own budget");

  // Reconnecting a known device replaces it, fails its jobs and closes the old stream.
  const provider = hub.provider(1, "device-0000", "p");
  const waiting = provider.chatJson({ messages: [], schema: {} });
  assert.notEqual(hub.attach(1, reg("device-0000"), (j) => sent.push(j.jobId), () => {}), null);
  await assert.rejects(waiting, /reconnected/);
  assert.deepEqual(closed, ["device-0000"]);
  detachers[0](); // the stale detach must not drop the new connection
  assert.equal(hub.devicesFor(1).length, MAX_DEVICES_PER_USER);

  // Only so many jobs may wait on one device.
  const jobs = Array.from({ length: MAX_PENDING_PER_DEVICE }, () => provider.chatJson({ messages: [], schema: {} }));
  jobs.forEach((j) => j.catch(() => {}));
  await assert.rejects(provider.chatJson({ messages: [], schema: {} }), /busy/);
  detachers[1]();
  for (const j of jobs) await j.then(() => {}, () => {});
});

test("device relay: connecting a sixth device is refused with 429, and a dead stream doesn't throw", async () => {
  const { app, alice } = await setup();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const aborts: AbortController[] = [];
  const connect = async (i: number) => {
    const abort = new AbortController();
    aborts.push(abort);
    return fetch(`${base}/api/llm/devices/connect`, {
      method: "POST",
      headers: { ...alice, "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: `device-${i}000`, name: "D", providers: [] }),
      signal: abort.signal,
    });
  };
  for (let i = 0; i < 5; i++) assert.equal((await connect(i)).status, 200);
  const sixth = await connect(9);
  assert.equal(sixth.status, 429);
  assert.equal(((await sixth.json()) as { error: string }).error, "too_many_devices");
  assert.equal((await connect(0)).status, 200, "an existing device may reconnect");
  aborts.forEach((a) => a.abort());
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

test("a timeout is described as slow, not unreachable, to ordinary users", () => {
  const timeout = new LlmError("Couldn't reach the LLM server: the request timed out");
  assert.match(publicMessage(timeout), /took too long/);
  assert.match(publicMessage(new LlmError("Couldn't reach Ollama: ECONNREFUSED")), /couldn't be reached/);
  assert.ok(!/ECONN|127\.0\.0\.1|timed out/.test(publicMessage(timeout)), "no upstream detail");
});
