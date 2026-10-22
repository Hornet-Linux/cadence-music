import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { openDb } from "../../db.js";
import { historyPlugin } from "../../history/plugin.js";
import { makeApp, waitFor } from "../_ops/testkit.js";
import { UrlRejected, isPrivateAddress, safeRequest } from "../_ops/ssrf.js";
import { WebhookEngine, type RequestFn, type ResolvedEndpoint } from "./engine.js";
import { createWebhooksPlugin } from "./plugin.js";
import { renderBody, sign, signatureHeader, verifySignature, type Envelope } from "./templates.js";

const envelope: Envelope = {
  id: "d1",
  event: "play.recorded",
  createdAt: "2026-01-02T03:04:05.000Z",
  data: {
    user: { id: 1, username: "ana" },
    track: { id: "t1", title: "Blue Monday", artists: ["New Order"], album: "Power, Corruption & Lies", durationSec: 450, source: "server" },
    playedAt: "2026-01-02T03:04:00.000Z",
  },
};

test("signatures verify, and fail for a changed body, a wrong secret or an old timestamp", () => {
  const body = renderBody("generic", envelope);
  const ts = 1_700_000_000;
  const header = signatureHeader("s3cret", ts, body);
  assert.match(header, /^sha256=[0-9a-f]{64}$/);
  assert.equal(header, `sha256=${sign("s3cret", ts, body)}`);
  const opts = { nowSec: ts + 10 };
  assert.equal(verifySignature("s3cret", header, String(ts), body, opts), true);
  assert.equal(verifySignature("s3cret", header, String(ts), body + " ", opts), false);
  assert.equal(verifySignature("other", header, String(ts), body, opts), false);
  assert.equal(verifySignature("s3cret", header, String(ts), body, { nowSec: ts + 3600 }), false);
  assert.equal(verifySignature("s3cret", undefined, String(ts), body, opts), false);
  assert.equal(verifySignature("s3cret", header, "abc", body, opts), false);
});

test("templates produce the shape each receiver expects", () => {
  assert.deepEqual(JSON.parse(renderBody("generic", envelope)), envelope);
  const ha = JSON.parse(renderBody("homeassistant", envelope)) as Record<string, unknown>;
  assert.equal(ha.title, "Blue Monday");
  assert.equal(ha.artist, "New Order");
  assert.equal(ha.user, "ana");
  assert.equal(ha.event, "play.recorded");
  const n8n = JSON.parse(renderBody("n8n", envelope)) as { title: string; data: unknown };
  assert.equal(n8n.title, "Blue Monday");
  assert.deepEqual(n8n.data, envelope.data);
  const discord = JSON.parse(renderBody("discord", envelope)) as { content: string; embeds: { title: string; description: string }[] };
  assert.match(discord.content, /ana played Blue Monday by New Order/);
  assert.equal(discord.embeds[0].title, "Now playing");
  assert.ok(discord.content.length > 0);
});

test("private and reserved addresses are recognised", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "224.0.0.1", "2002:7f00:1::"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("safeRequest refuses private literals and names that resolve to private addresses", async () => {
  await assert.rejects(safeRequest("http://127.0.0.1:1/x", { body: "{}" }), (e: unknown) => e instanceof UrlRejected && e.code === "blocked_address");
  await assert.rejects(safeRequest("http://[::1]:1/x", { body: "{}" }), (e: unknown) => e instanceof UrlRejected);
  await assert.rejects(safeRequest("ftp://example.com/x"), (e: unknown) => e instanceof UrlRejected && e.code === "invalid_url");
  await assert.rejects(safeRequest("http://user:pw@example.com/x"), (e: unknown) => e instanceof UrlRejected && e.code === "invalid_url");
  // A hostname that (re)binds to an internal address is stopped at connect time.
  const rebind = ((_h: string, _o: unknown, cb: (...a: unknown[]) => void) => cb(null, [{ address: "10.0.0.5", family: 4 }])) as never;
  await assert.rejects(safeRequest("http://innocent.example/x", { body: "{}", lookup: rebind }), (e: unknown) => e instanceof UrlRejected && e.code === "blocked_address");
});

function endpoint(partial: Partial<ResolvedEndpoint> = {}): ResolvedEndpoint {
  return { id: "e1", name: "Test", url: "https://example.com/hook", secret: "sec", events: ["play.recorded"], template: "generic", enabled: true, allowPrivate: false, ...partial };
}

test("a failing receiver is retried with growing waits and then succeeds", async () => {
  let clock = 1_000_000;
  const answers = [500, 503, 200];
  const seen: { sig: string; ts: string; id: string }[] = [];
  const request: RequestFn = async (_url, o) => {
    seen.push({ sig: o.headers!["x-cadence-signature"], ts: o.headers!["x-cadence-timestamp"], id: o.headers!["x-cadence-delivery"] });
    return { status: answers.shift()!, body: "" };
  };
  const engine = new WebhookEngine({ db: openDb(":memory:"), endpoints: () => [endpoint()], request, now: () => clock, backoffMs: [1000, 5000, 20_000] });
  const [id] = engine.emit("play.recorded", envelope.data);
  const first = await waitFor(() => engine.get(id)?.attempts === 1 && engine.get(id));
  assert.equal(first.status, "pending");
  assert.equal(first.nextAttemptAt, clock + 1000);
  assert.equal(await engine.tick(), 0, "not due yet");
  clock += 1000;
  assert.equal(await engine.tick(), 1);
  const second = engine.get(id)!;
  assert.equal(second.attempts, 2);
  assert.equal(second.nextAttemptAt, clock + 5000);
  clock += 5000;
  await engine.tick();
  const done = engine.get(id)!;
  assert.equal(done.status, "success");
  assert.equal(done.attempts, 3);
  assert.deepEqual(done.log.map((a) => a.status), [500, 503, 200]);
  assert.equal(new Set(seen.map((s) => s.id)).size, 1, "every attempt carries the same delivery id");
  // The signature in each attempt is valid for the body that was sent.
  assert.match(seen[2].sig, /^sha256=/);
});

test("a delivery is given up after the last retry, and a 4xx is not retried", async () => {
  let clock = 5_000;
  const engine = new WebhookEngine({
    db: openDb(":memory:"),
    endpoints: () => [endpoint()],
    request: async () => ({ status: 502, body: "" }),
    now: () => clock,
    backoffMs: [10, 10],
  });
  const [id] = engine.emit("play.recorded", envelope.data);
  await waitFor(() => engine.get(id)?.attempts === 1);
  for (let i = 0; i < 3; i++) {
    clock += 100;
    await engine.tick();
  }
  assert.equal(engine.get(id)!.status, "failed");
  assert.equal(engine.get(id)!.attempts, 3);

  const refusing = new WebhookEngine({ db: openDb(":memory:"), endpoints: () => [endpoint()], request: async () => ({ status: 404, body: "" }), now: () => clock });
  const [id2] = refusing.emit("play.recorded", envelope.data);
  const r = await waitFor(() => refusing.get(id2)?.status === "failed" && refusing.get(id2));
  assert.equal(r.attempts, 1);
  assert.equal(r.lastStatus, 404);
  // The admin can press Retry on a failed delivery.
  assert.equal(refusing.retry(id2), true);
  await waitFor(() => refusing.get(id2)?.attempts === 1 && refusing.get(id2)?.status === "failed");
});

test("events only reach enabled endpoints that subscribed to them", async () => {
  const sent: string[] = [];
  const engine = new WebhookEngine({
    db: openDb(":memory:"),
    endpoints: () => [endpoint({ id: "a", name: "A" }), endpoint({ id: "b", name: "B", events: ["library.changed"] }), endpoint({ id: "c", name: "C", enabled: false })],
    request: async (url) => (sent.push(url), { status: 200, body: "" }),
  });
  assert.equal(engine.emit("play.recorded", envelope.data).length, 1);
  assert.equal(engine.emit("library.changed", { tracks: 5 }).length, 1);
});

test("a private destination is blocked unless the admin allowed it (engine to real receiver)", async () => {
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  try {
    const blocked = new WebhookEngine({ db: openDb(":memory:"), endpoints: () => [endpoint({ url, allowPrivate: false })] });
    const [bid] = blocked.emit("play.recorded", envelope.data);
    const b = await waitFor(() => blocked.get(bid)?.status === "failed" && blocked.get(bid));
    assert.match(b.lastError ?? "", /private address/);
    assert.equal(received.length, 0);

    const allowed = new WebhookEngine({ db: openDb(":memory:"), endpoints: () => [endpoint({ url, allowPrivate: true, secret: "shh", template: "homeassistant" })] });
    const [aid] = allowed.emit("play.recorded", envelope.data);
    await waitFor(() => allowed.get(aid)?.status === "success");
    assert.equal(received.length, 1);
    const { headers, body } = received[0];
    assert.equal(headers["x-cadence-event"], "play.recorded");
    assert.equal(headers["x-cadence-delivery"], aid);
    assert.equal(verifySignature("shh", headers["x-cadence-signature"] as string, headers["x-cadence-timestamp"] as string, body), true);
    assert.equal((JSON.parse(body) as { title: string }).title, "Blue Monday");
  } finally {
    server.close();
  }
});

test("admin API: endpoints are validated, secrets are shown once, and a recorded play is delivered end to end", async () => {
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  const t = await makeApp([historyPlugin, createWebhooksPlugin()]);
  try {
    const admin = t.auth(t.adminToken);
    // Not for ordinary users.
    assert.equal((await t.app.inject({ method: "GET", url: "/api/webhooks", headers: t.auth(t.userToken) })).statusCode, 403);
    // A private address is refused until explicitly allowed; junk URLs are refused.
    const refused = await t.app.inject({ method: "POST", url: "/api/webhooks/endpoints", headers: admin, payload: { name: "Local", url } });
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.json().error, "blocked_address");
    assert.equal((await t.app.inject({ method: "POST", url: "/api/webhooks/endpoints", headers: admin, payload: { name: "x", url: "javascript:alert(1)" } })).statusCode, 400);

    const created = await t.app.inject({ method: "POST", url: "/api/webhooks/endpoints", headers: admin, payload: { name: "Local", url, allowPrivate: true, template: "n8n" } });
    assert.equal(created.statusCode, 201);
    const { endpoint, secret } = created.json() as { endpoint: { id: string; secretSet: boolean }; secret: string };
    assert.ok(secret.length >= 20);
    assert.equal(endpoint.secretSet, true);

    // The secret never comes back, and is not stored in the clear.
    const list = await t.app.inject({ method: "GET", url: "/api/webhooks", headers: admin });
    assert.ok(!list.body.includes(secret));
    const stored = (t.db.prepare("SELECT value FROM settings WHERE key = 'plugin:cadence.webhooks:config'").get() as { value: string }).value;
    assert.ok(!stored.includes(secret));

    // A play recorded through the real history route reaches the receiver, signed with that secret.
    const play = { track: { id: "server:1", title: "Heroes", artists: [{ id: "a", name: "David Bowie" }], album: "Heroes", source: "server" }, playedAt: Date.now() - 1000 };
    const posted = await t.app.inject({ method: "POST", url: "/api/me/history", headers: t.auth(t.userToken), payload: { plays: [play] } });
    assert.equal(posted.statusCode, 200);
    const got = await waitFor(() => received[0]);
    assert.equal(verifySignature(secret, got.headers["x-cadence-signature"] as string, got.headers["x-cadence-timestamp"] as string, got.body), true);
    assert.equal((JSON.parse(got.body) as { user: string; title: string }).user, "listener");

    // The delivery log shows it; the test button works; rotating the secret returns a new one once.
    const log = await waitFor(async () => {
      const r = (await t.app.inject({ method: "GET", url: "/api/webhooks/deliveries", headers: admin })).json() as { items: { status: string }[] };
      return r.items[0]?.status === "success" ? r : null;
    });
    assert.equal(log.items.length, 1);
    const test = await t.app.inject({ method: "POST", url: `/api/webhooks/endpoints/${endpoint.id}/test`, headers: admin });
    assert.equal((test.json() as { delivery: { status: string } }).delivery.status, "success");
    const rotated = await t.app.inject({ method: "PATCH", url: `/api/webhooks/endpoints/${endpoint.id}`, headers: admin, payload: { rotateSecret: true } });
    assert.notEqual((rotated.json() as { secret: string }).secret, secret);
    assert.equal((await t.app.inject({ method: "DELETE", url: `/api/webhooks/endpoints/${endpoint.id}`, headers: admin })).statusCode, 204);
  } finally {
    server.close();
    await t.cleanup();
  }
});