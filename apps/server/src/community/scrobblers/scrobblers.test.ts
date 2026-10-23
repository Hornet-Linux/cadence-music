import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AuthResponse } from "@uma/shared";
import { buildApp } from "../../app.js";
import { createLocalUser } from "../../auth/users.js";
import { openDb } from "../../db.js";
import { historyPlugin } from "../../history/plugin.js";
import type { PlayEvent } from "../../plugins/runtime.js";
import { Settings } from "../../settings.js";
import { backoffMs, Scrobbler, toScrobble, ScrobblerError } from "./engine.js";
import { createScrobblersPlugin } from "./plugin.js";

const log = { warn() {}, error() {}, info() {}, debug() {} } as never;

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string;
  form: URLSearchParams | null;
  json: Record<string, unknown> | null;
}

/** A programmable fetch: `route` answers requests, `calls` records them. */
function makeFetch(route: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === "string" ? init.body : "";
    const call: Call = {
      url: new URL(String(input)),
      method: init.method ?? "GET",
      headers,
      body,
      form: String(headers["Content-Type"] ?? "").includes("x-www-form") ? new URLSearchParams(body) : null,
      json: String(headers["Content-Type"] ?? "").includes("json") ? (JSON.parse(body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    return route(call);
  }) as typeof fetch;
  return { fn, calls };
}
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

/** A happy-path world: all four services accept everything. */
const friendly = (c: Call) => {
  const p = c.url.pathname;
  if (p.endsWith("/validate-token")) return reply({ valid: true, user_name: "lb-user" });
  if (p.endsWith("/submit-listens")) return reply({ status: "ok" });
  if (p.includes("/apis/mlj_1/test")) return reply({ status: "ok" });
  if (p.includes("/apis/mlj_1/newscrobble")) return reply({ status: "success" });
  const method = c.url.searchParams.get("method") ?? c.form?.get("method");
  if (method === "auth.getToken") return reply({ token: "reqtoken" });
  if (method === "auth.getSession") return reply({ session: { name: "fm-user", key: "SESSIONKEY-1" } });
  if (method === "track.scrobble") return reply({ scrobbles: { "@attr": { accepted: 1, ignored: 0 } } });
  if (method === "user.getInfo") return reply({ user: { name: "fm-user" } });
  return reply({ error: 3, message: "Invalid method" });
};

const NOW = 1_700_000_000_000;
let sequence = 0;

function play(userId: number, title: string, playedAtMs: number, extra: Partial<PlayEvent["track"]> = {}): PlayEvent {
  return {
    userId,
    playedAt: playedAtMs,
    track: { id: `t:${title}`, title, artists: [{ id: "a", name: "Artist" }], album: "Album", durationSec: 200, ...extra },
  };
}

async function setup(route: (c: Call) => Response | Promise<Response> = friendly) {
  const db = openDb(":memory:");
  const alice = await createLocalUser(db, { username: `alice${sequence++}`, password: "alice-password" });
  const bob = await createLocalUser(db, { username: `bob${sequence++}`, password: "bob-password" });
  const settings = new Settings(db, {} as never);
  const f = makeFetch(route);
  const clock = { now: NOW };
  const engine = new Scrobbler({
    db,
    settings,
    secret: "s".repeat(64),
    log,
    fetchFn: f.fn,
    now: () => clock.now,
    sleep: async () => {},
    autoFlushDelayMs: null,
  });
  return { db, alice: alice.id, bob: bob.id, settings, engine, f, clock };
}

const LFM_KEYS = { lastfm: { apiKey: "lastfmapikey1234", apiSecret: "lastfmsecret1234" } };

test("rules: short tracks, missing artists, future plays and bad text are not scrobbled", () => {
  assert.equal(toScrobble(play(1, "Intro", NOW, { durationSec: 29 }), NOW), null, "under 30 seconds");
  assert.ok(toScrobble(play(1, "Song", NOW, { durationSec: 30 }), NOW), "exactly 30 seconds is fine");
  assert.ok(toScrobble(play(1, "Song", NOW, { durationSec: undefined }), NOW), "unknown length is fine");
  assert.equal(toScrobble(play(1, "  ", NOW), NOW), null, "no title");
  assert.equal(toScrobble({ ...play(1, "S", NOW), track: { id: "x", title: "S", artists: [] } }, NOW), null, "no artist");
  assert.equal(toScrobble(play(1, "S", NOW + 3_600_000), NOW), null, "future");
  const s = toScrobble(play(1, "Hi\u0000  there\n", NOW, { artists: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }), NOW)!;
  assert.equal(s.title, "Hi there");
  assert.equal(s.artist, "A");
  assert.deepEqual(s.artists, ["A", "B"]);
  assert.equal(s.playedAt, NOW / 1000, "seconds, not milliseconds");
});

test("backoff doubles from 30 seconds up to six hours", () => {
  assert.deepEqual([0, 1, 2, 3].map(backoffMs), [30_000, 60_000, 120_000, 240_000]);
  assert.equal(backoffMs(30), 6 * 3600_000);
});

test("nothing is queued or sent when no service is connected", async () => {
  const t = await setup();
  assert.equal(t.engine.onPlay(play(t.alice, "Song", NOW - 1000)), 0);
  assert.deepEqual(await t.engine.flush(), { sent: 0, retried: 0, dropped: 0 });
  assert.equal(t.f.calls.length, 0);
});

test("Last.fm and Libre.fm need the owner's keys; Libre.fm works without; Maloja needs custom addresses allowed", async () => {
  const t = await setup();
  await assert.rejects(t.engine.connectLastfmLike(t.alice, "lastfm"), (e: ScrobblerError) => e.status === 409 && e.code === "not_configured");
  assert.equal(t.f.calls.length, 0, "no request without keys");
  const status = t.engine.status(t.alice);
  const lastfm = status.services.find((s) => s.id === "lastfm")!;
  assert.equal(lastfm.available, false);
  assert.match(lastfm.unavailableReason ?? "", /API keys/);
  assert.equal(status.services.find((s) => s.id === "librefm")!.available, true);
  await assert.rejects(t.engine.connectMaloja(t.alice, "https://m.example", "key"), (e: ScrobblerError) => e.status === 403);
  await assert.rejects(
    t.engine.connectListenBrainz(t.alice, "token-12345678", "https://lb.example"),
    (e: ScrobblerError) => e.code === "custom_hosts_disabled",
  );
});

test("Last.fm: token flow, then plays are signed and sent; secrets are stored sealed", async () => {
  const t = await setup();
  t.engine.saveAdminConfig(LFM_KEYS);
  const { approveUrl } = await t.engine.connectLastfmLike(t.alice, "lastfm");
  assert.equal(new URL(approveUrl).searchParams.get("token"), "reqtoken");
  assert.equal(t.engine.status(t.alice).services[0]!.awaitingApproval, true);
  assert.equal(t.engine.status(t.alice).services[0]!.connected, false);
  assert.deepEqual(await t.engine.finishLastfmLike(t.alice, "lastfm"), { username: "fm-user" });
  assert.equal(t.engine.status(t.alice).services[0]!.connected, true);

  assert.equal(t.engine.onPlay(play(t.alice, "Song", NOW - 5000)), 1);
  assert.deepEqual(await t.engine.flush(), { sent: 1, retried: 0, dropped: 0 });
  const scrobble = t.f.calls.find((c) => c.form?.get("method") === "track.scrobble")!;
  assert.equal(scrobble.form!.get("sk"), "SESSIONKEY-1");
  assert.equal(scrobble.form!.get("track[0]"), "Song");
  assert.equal(scrobble.form!.get("timestamp[0]"), String((NOW - 5000) / 1000));

  // Nothing readable at rest.
  const raw = JSON.stringify(
    t.db.prepare("SELECT key, value FROM settings").all(),
  );
  assert.ok(!raw.includes("SESSIONKEY-1"), "session key is sealed");
  assert.ok(!raw.includes("lastfmsecret1234"), "app secret is sealed");
  const status = JSON.stringify(t.engine.status(t.alice));
  assert.ok(!status.includes("SESSIONKEY-1"));
});

test("Last.fm finish before approval says so and keeps the pending token for another try", async () => {
  let approved = false;
  const t = await setup((c) => {
    const method = c.url.searchParams.get("method");
    if (method === "auth.getSession" && !approved) return reply({ error: 14, message: "Unauthorized Token" });
    return friendly(c);
  });
  t.engine.saveAdminConfig(LFM_KEYS);
  await t.engine.connectLastfmLike(t.alice, "lastfm");
  await assert.rejects(t.engine.finishLastfmLike(t.alice, "lastfm"), (e: ScrobblerError) => e.code === "not_approved");
  approved = true;
  assert.equal((await t.engine.finishLastfmLike(t.alice, "lastfm")).username, "fm-user");
  await assert.rejects(t.engine.finishLastfmLike(t.bob, "lastfm"), (e: ScrobblerError) => e.code === "no_pending");
});

test("Last.fm refuses plays older than 14 days, ListenBrainz does not", async () => {
  const t = await setup();
  t.engine.saveAdminConfig(LFM_KEYS);
  await t.engine.connectLastfmLike(t.alice, "lastfm");
  await t.engine.finishLastfmLike(t.alice, "lastfm");
  await t.engine.connectListenBrainz(t.alice, "lb-token-12345");
  const old = NOW - 20 * 86_400_000;
  assert.equal(t.engine.onPlay(play(t.alice, "Old", old)), 1, "only ListenBrainz");
  await t.engine.flush();
  assert.ok(t.f.calls.some((c) => c.url.pathname.endsWith("/submit-listens")));
  assert.ok(!t.f.calls.some((c) => c.form?.get("method") === "track.scrobble"));
});

test("ListenBrainz: connect validates the token; a flush sends one request with the right payload", async () => {
  const t = await setup();
  assert.deepEqual(await t.engine.connectListenBrainz(t.alice, "lb-token-12345"), { username: "lb-user" });
  const validate = t.f.calls[0]!;
  assert.equal(validate.headers.Authorization, "Token lb-token-12345");
  assert.equal(t.engine.onPlay(play(t.alice, "One", NOW - 3000)), 1);
  assert.equal(t.engine.onPlay(play(t.alice, "Two", NOW - 2000)), 1);
  assert.deepEqual(await t.engine.flush(), { sent: 2, retried: 0, dropped: 0 });
  const submits = t.f.calls.filter((c) => c.url.pathname === "/1/submit-listens");
  assert.equal(submits.length, 1, "batched");
  assert.equal(submits[0]!.url.origin, "https://api.listenbrainz.org");
  const body = submits[0]!.json as { listen_type: string; payload: { track_metadata: { track_name: string } }[] };
  assert.equal(body.listen_type, "import");
  assert.deepEqual(body.payload.map((p) => p.track_metadata.track_name), ["One", "Two"]);
  const s = t.engine.status(t.alice).services.find((x) => x.id === "listenbrainz")!;
  assert.equal(s.sent, 2);
  assert.equal(s.queue.pending, 0);
  assert.equal(s.queue.sentToday, 2);
});

test("a wrong ListenBrainz token is rejected at connect and nothing is saved", async () => {
  const t = await setup((c) => (c.url.pathname.endsWith("validate-token") ? reply({ valid: false }) : friendly(c)));
  await assert.rejects(t.engine.connectListenBrainz(t.alice, "wrong-token-123"), (e: ScrobblerError) => e.code === "rejected");
  assert.equal(t.engine.status(t.alice).services.find((x) => x.id === "listenbrainz")!.connected, false);
  assert.equal(t.settings.pluginUserConfig("cadence.scrobblers", t.alice), undefined);
});

test("self-hosted ListenBrainz and Maloja work once the owner allows custom addresses", async () => {
  const t = await setup();
  t.engine.saveAdminConfig({ allowCustomHosts: true });
  await t.engine.connectListenBrainz(t.alice, "lb-token-12345", "https://lb.home.example/1");
  await t.engine.connectMaloja(t.alice, "https://maloja.home.example/", "mal-key");
  t.engine.onPlay(play(t.alice, "Song", NOW - 1000));
  await t.engine.flush();
  assert.ok(t.f.calls.some((c) => c.url.href === "https://lb.home.example/1/submit-listens"));
  const mj = t.f.calls.find((c) => c.url.href === "https://maloja.home.example/apis/mlj_1/newscrobble")!;
  assert.equal(mj.json!.key, "mal-key");
  assert.equal(mj.json!.title, "Song");
  assert.ok(!t.f.calls.some((c) => c.url.hostname === "api.listenbrainz.org"), "never falls back to the public server");

  // If the owner turns custom addresses off later, deliveries pause instead of reaching out.
  t.engine.saveAdminConfig({ allowCustomHosts: false });
  const before = t.f.calls.length;
  t.engine.onPlay(play(t.alice, "Next", NOW - 500));
  await t.engine.flush();
  assert.equal(t.f.calls.length, before);
  assert.match(t.engine.status(t.alice).services.find((x) => x.id === "maloja")!.lastError?.message ?? "", /turned off/);
});

test("retry: a server error backs off 30s, 60s, 120s and delivers when the service recovers", async () => {
  let failing = true;
  const t = await setup((c) => (c.url.pathname.endsWith("/submit-listens") && failing ? reply({ error: "down" }, 503) : friendly(c)));
  await t.engine.connectListenBrainz(t.alice, "lb-token-12345");
  t.engine.onPlay(play(t.alice, "Song", NOW - 1000));
  const submits = () => t.f.calls.filter((c) => c.url.pathname.endsWith("/submit-listens")).length;

  assert.deepEqual(await t.engine.flush(), { sent: 0, retried: 1, dropped: 0 });
  assert.equal(submits(), 1);
  let next = t.engine.status(t.alice).services.find((x) => x.id === "listenbrainz")!.queue;
  assert.equal(next.pending, 1);
  assert.equal(next.nextAttemptAt, NOW + 30_000);

  t.clock.now += 10_000; // too early: nothing is sent
  await t.engine.flush();
  assert.equal(submits(), 1);

  t.clock.now = NOW + 30_000;
  await t.engine.flush();
  assert.equal(submits(), 2);
  next = t.engine.status(t.alice).services.find((x) => x.id === "listenbrainz")!.queue;
  assert.equal(next.nextAttemptAt, NOW + 30_000 + 60_000);

  failing = false;
  t.clock.now = NOW + 90_000;
  assert.deepEqual(await t.engine.flush(), { sent: 1, retried: 0, dropped: 0 });
  const s = t.engine.status(t.alice).services.find((x) => x.id === "listenbrainz")!;
  assert.equal(s.queue.pending, 0);
  assert.equal(s.lastError, undefined, "success clears the error");
});

test("a rate limit answer sets the next try from Retry-After", async () => {
  const t = await setup((c) => (c.url.pathname.endsWith("/submit-listens") ? reply({}, 429, { "Retry-After": "120" }) : friendly(c)));
  await t.engine.connectListenBrainz(t.alice, "lb-token-12345");
  t.engine.onPlay(play(t.alice, "Song", NOW - 1000));
  await t.engine.flush();
  assert.equal(t.engine.status(t.alice).services.find((x) => x.id === "listenbrainz")!.queue.nextAttemptAt, NOW + 120_000);
});

test("plays that cannot be delivered for the retention period are dropped", async () => {
  const t = await setup((c) => (c.url.pathname.endsWith("/submit-listens") ? reply({}, 500) : friendly(c)));
  t.engine.saveAdminConfig({ retryDays: 2 });
  await t.engine.connectListenBrainz(t.alice, "lb-token-12345");
  t.engine.onPlay(play(t.alice, "Song", NOW - 1000));
  await t.engine.flush();
  t.clock.now = NOW + 3 * 86_400_000;
  await t.engine.flush();
  const q = t.engine.status(t.alice).services.find((x) => x.id === "listenbrainz")!.queue;
  assert.equal(q.pending, 0);
  assert.equal(q.dropped, 1);
});

test("a refused sign-in pauses the service, keeps the plays, and resumes after a good test", async () => {
  let revoked = true;
  const t = await setup((c) => (c.url.pathname.endsWith("/submit-listens") && revoked ? reply({}, 401) : friendly(c)));
  await t.engine.connectListenBrainz(t.alice, "lb-token-12345");
  t.engine.onPlay(play(t.alice, "Song", NOW - 1000));
  await t.engine.flush();
  let s = t.engine.status(t.alice).services.find((x) => x.id === "listenbrainz")!;
  assert.equal(s.needsReauth, true);
  assert.match(s.lastError?.message ?? "", /token/i);
  assert.equal(s.queue.pending, 1);

  const calls = t.f.calls.length;
  t.clock.now += 7 * 3600_000;
  await t.engine.flush();
  assert.equal(t.f.calls.length, calls, "no requests while sign-in is broken");

  revoked = false;
  await t.engine.test(t.alice, "listenbrainz");
  s = t.engine.status(t.alice).services.find((x) => x.id === "listenbrainz")!;
  assert.equal(s.needsReauth, false);
  await t.engine.retryNow(t.alice);
  assert.equal(t.engine.status(t.alice).services.find((x) => x.id === "listenbrainz")!.queue.pending, 0);
});

test("one rejected play does not sink the others in a batch", async () => {
  const t = await setup((c) => {
    if (c.url.pathname.endsWith("/submit-listens")) {
      const payload = (c.json as { payload: { track_metadata: { track_name: string } }[] }).payload;
      return payload.some((p) => p.track_metadata.track_name === "Bad") ? reply({ code: 400 }, 400) : reply({ status: "ok" });
    }
    return friendly(c);
  });
  await t.engine.connectListenBrainz(t.alice, "lb-token-12345");
  t.engine.onPlay(play(t.alice, "Good", NOW - 3000));
  t.engine.onPlay(play(t.alice, "Bad", NOW - 2000));
  t.engine.onPlay(play(t.alice, "Fine", NOW - 1000));
  assert.deepEqual(await t.engine.flush(), { sent: 2, retried: 0, dropped: 1 });
  const q = t.engine.status(t.alice).services.find((x) => x.id === "listenbrainz")!.queue;
  assert.equal(q.dropped, 1);
  assert.equal(t.engine.status(t.alice).problems[0]?.title, "Bad");
});

test("dedupe: the same play, or the same song reported again within seconds, is sent once", async () => {
  const t = await setup();
  await t.engine.connectListenBrainz(t.alice, "lb-token-12345");
  assert.equal(t.engine.onPlay(play(t.alice, "Song", NOW - 100_000)), 1);
  assert.equal(t.engine.onPlay(play(t.alice, "Song", NOW - 100_000)), 0, "identical");
  assert.equal(t.engine.onPlay(play(t.alice, "Song", NOW - 95_000)), 0, "another device, 5 seconds apart");
  assert.equal(t.engine.onPlay(play(t.alice, "Song", NOW - 40_000)), 1, "a real repeat later");
  await t.engine.flush();
  assert.equal(t.engine.onPlay(play(t.alice, "Song", NOW - 100_000)), 0, "still recognised after it was sent");
  await t.engine.flush();
  const sent = t.f.calls.filter((c) => c.url.pathname.endsWith("/submit-listens")).flatMap((c) => (c.json as { payload: unknown[] }).payload);
  assert.equal(sent.length, 2);
});

test("people are isolated: credentials, queues, counts and disconnects never cross", async () => {
  const t = await setup();
  await t.engine.connectListenBrainz(t.alice, "alice-token-1234");
  t.engine.onPlay(play(t.alice, "Alice song", NOW - 2000));
  assert.equal(t.engine.onPlay(play(t.bob, "Bob song", NOW - 1000)), 0, "bob connected nothing");
  await t.engine.flush();
  const submits = t.f.calls.filter((c) => c.url.pathname.endsWith("/submit-listens"));
  assert.equal(submits.length, 1);
  assert.equal(submits[0]!.headers.Authorization, "Token alice-token-1234");
  assert.ok(!submits[0]!.body.includes("Bob song"));

  assert.equal(t.engine.status(t.bob).services.find((x) => x.id === "listenbrainz")!.connected, false);
  assert.equal(t.engine.status(t.bob).services.find((x) => x.id === "listenbrainz")!.sent, 0);

  // Bob connects later with his own token; Alice's stay put.
  await t.engine.connectListenBrainz(t.bob, "bob-token-12345");
  t.engine.onPlay(play(t.bob, "Bob again", NOW - 500));
  t.engine.disconnect(t.alice, "listenbrainz");
  assert.equal(t.engine.status(t.bob).services.find((x) => x.id === "listenbrainz")!.queue.pending, 1);
  await t.engine.flush();
  const last = t.f.calls.filter((c) => c.url.pathname.endsWith("/submit-listens")).at(-1)!;
  assert.equal(last.headers.Authorization, "Token bob-token-12345");
  assert.equal(t.engine.status(t.alice).services.find((x) => x.id === "listenbrainz")!.connected, false);
});

test("disabling a service stops queueing; disconnecting clears what was waiting", async () => {
  const t = await setup((c) => (c.url.pathname.endsWith("/submit-listens") ? reply({}, 500) : friendly(c)));
  await t.engine.connectListenBrainz(t.alice, "lb-token-12345");
  t.engine.onPlay(play(t.alice, "One", NOW - 3000));
  t.engine.setEnabled(t.alice, "listenbrainz", false);
  assert.equal(t.engine.onPlay(play(t.alice, "Two", NOW - 2000)), 0);
  assert.equal(t.engine.status(t.alice).services.find((x) => x.id === "listenbrainz")!.enabled, false);
  t.engine.setEnabled(t.alice, "listenbrainz", true);
  assert.equal(t.engine.onPlay(play(t.alice, "Three", NOW - 1000)), 1);
  t.engine.disconnect(t.alice, "listenbrainz");
  assert.equal(t.engine.queue.counts(t.alice, "listenbrainz", NOW).pending, 0);
  assert.throws(() => t.engine.setEnabled(t.alice, "listenbrainz", true), (e: ScrobblerError) => e.status === 409);
});

test("Maloja connect failure with a bad key saves nothing", async () => {
  const t = await setup((c) => (c.url.pathname.includes("/apis/mlj_1/test") ? reply({}, 403) : friendly(c)));
  t.engine.saveAdminConfig({ allowCustomHosts: true });
  await assert.rejects(t.engine.connectMaloja(t.alice, "https://maloja.example", "nope"), (e: ScrobblerError) => e.code === "rejected");
  assert.equal(t.engine.status(t.alice).services.find((x) => x.id === "maloja")!.connected, false);
});

// ---- through the real server ----

async function appWith(route: (c: Call) => Response | Promise<Response> = friendly) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-scrob-"));
  const db = openDb(":memory:");
  await createLocalUser(db, { username: "admin", password: "admin-password", isAdmin: true });
  await createLocalUser(db, { username: "alice", password: "alice-password" });
  await createLocalUser(db, { username: "bob", password: "bob-password" });
  const f = makeFetch(route);
  const app = await buildApp({
    config: { host: "127.0.0.1", port: 0, dataDir: dir, musicDir: dir, scanIntervalMinutes: 0, trustProxy: false, logLevel: "silent" },
    db,
    secret: "s".repeat(64),
    logger: false,
    plugins: [historyPlugin, createScrobblersPlugin({ fetchFn: f.fn, sleep: async () => {}, autoFlushDelayMs: 0 })],
  });
  const signIn = async (username: string) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: `${username}-password` } });
    return { authorization: `Bearer ${(res.json() as AuthResponse).token}` };
  };
  return { app, f, admin: await signIn("admin"), alice: await signIn("alice"), bob: await signIn("bob") };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};

test("routes: sign-in required, status never leaks secrets, admin config is admin-only", async () => {
  const s = await appWith();
  assert.equal((await s.app.inject({ method: "GET", url: "/api/scrobblers/status" })).statusCode, 401);
  assert.equal((await s.app.inject({ method: "PUT", url: "/api/scrobblers/admin/config", headers: s.alice, payload: {} })).statusCode, 403);
  const put = await s.app.inject({
    method: "PUT",
    url: "/api/scrobblers/admin/config",
    headers: s.admin,
    payload: { lastfm: { apiKey: "lastfmapikey1234", apiSecret: "lastfmsecret1234" }, allowCustomHosts: true },
  });
  assert.equal(put.statusCode, 204);
  const cfg = (await s.app.inject({ method: "GET", url: "/api/scrobblers/admin/config", headers: s.admin })).json();
  assert.deepEqual(cfg.lastfm, { apiKey: "lastfmapikey1234", hasSecret: true });
  assert.ok(!JSON.stringify(cfg).includes("lastfmsecret1234"));
  const bad = await s.app.inject({ method: "PUT", url: "/api/scrobblers/admin/config", headers: s.admin, payload: { retryDays: 99 } });
  assert.equal(bad.statusCode, 400);

  const status = (await s.app.inject({ method: "GET", url: "/api/scrobblers/status", headers: s.alice })).json();
  assert.equal(status.isAdmin, false);
  assert.deepEqual(status.services.map((x: { id: string }) => x.id), ["lastfm", "librefm", "listenbrainz", "maloja"]);
  assert.equal(status.services[0].available, true);
  await s.app.close();
});

test("end to end: connect Last.fm and ListenBrainz over HTTP, then a play recorded from any device is scrobbled", async () => {
  const s = await appWith();
  await s.app.inject({
    method: "PUT",
    url: "/api/scrobblers/admin/config",
    headers: s.admin,
    payload: { lastfm: { apiKey: "lastfmapikey1234", apiSecret: "lastfmsecret1234" } },
  });
  const connect = await s.app.inject({ method: "POST", url: "/api/scrobblers/lastfm/connect", headers: s.alice, payload: {} });
  assert.equal(connect.statusCode, 200);
  assert.match(connect.json().approveUrl, /^https:\/\/www\.last\.fm\/api\/auth\/\?/);
  const finish = await s.app.inject({ method: "POST", url: "/api/scrobblers/lastfm/finish", headers: s.alice });
  assert.equal(finish.json().username, "fm-user");
  const lb = await s.app.inject({
    method: "POST",
    url: "/api/scrobblers/listenbrainz/connect",
    headers: s.alice,
    payload: { token: "lb-token-12345" },
  });
  assert.equal(lb.json().username, "lb-user");
  const test = await s.app.inject({ method: "POST", url: "/api/scrobblers/lastfm/test", headers: s.alice });
  assert.equal(test.json().ok, true);

  const record = await s.app.inject({
    method: "POST",
    url: "/api/me/history",
    headers: s.alice,
    payload: {
      plays: [
        {
          playedAt: Date.now() - 5000,
          track: { id: "spotify:track:1", title: "Phone play", artists: [{ id: "a", name: "Artist" }], durationSec: 180 },
        },
      ],
    },
  });
  assert.equal(record.json().stored, 1);
  await until(() => s.f.calls.some((c) => c.url.pathname.endsWith("/submit-listens")) && s.f.calls.some((c) => c.form?.get("method") === "track.scrobble"));
  assert.ok(s.f.calls.some((c) => c.url.pathname.endsWith("/submit-listens")), "ListenBrainz got it");
  assert.ok(s.f.calls.some((c) => c.form?.get("method") === "track.scrobble"), "Last.fm got it");

  // Bob records a play: nothing goes out for him.
  const before = s.f.calls.length;
  await s.app.inject({
    method: "POST",
    url: "/api/me/history",
    headers: s.bob,
    payload: { plays: [{ playedAt: Date.now() - 4000, track: { id: "x", title: "Bob play", artists: [{ id: "a", name: "A" }] } }] },
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.f.calls.length, before);

  const status = (await s.app.inject({ method: "GET", url: "/api/scrobblers/status", headers: s.alice })).json();
  const lbStatus = status.services.find((x: { id: string }) => x.id === "listenbrainz");
  assert.equal(lbStatus.connected, true);
  assert.equal(lbStatus.username, "lb-user");
  assert.ok(!JSON.stringify(status).includes("lb-token-12345"));
  const queue = (await s.app.inject({ method: "GET", url: "/api/scrobblers/queue", headers: s.alice })).json();
  assert.equal(queue.services.find((x: { id: string }) => x.id === "listenbrainz").pending, 0);

  const off = await s.app.inject({ method: "PATCH", url: "/api/scrobblers/listenbrainz", headers: s.alice, payload: { enabled: false } });
  assert.equal(off.statusCode, 200);
  const gone = await s.app.inject({ method: "DELETE", url: "/api/scrobblers/listenbrainz", headers: s.alice });
  assert.equal(gone.statusCode, 204);
  const after = (await s.app.inject({ method: "GET", url: "/api/scrobblers/status", headers: s.alice })).json();
  assert.equal(after.services.find((x: { id: string }) => x.id === "listenbrainz").connected, false);
  assert.equal((await s.app.inject({ method: "GET", url: "/api/scrobblers/nope/x", headers: s.alice })).statusCode, 404);
  assert.equal((await s.app.inject({ method: "POST", url: "/api/scrobblers/nope/connect", headers: s.alice })).statusCode, 404);
  await s.app.close();
});

test("routes: connect errors are clear and unconfigured services say so", async () => {
  const s = await appWith();
  const noKeys = await s.app.inject({ method: "POST", url: "/api/scrobblers/lastfm/connect", headers: s.alice, payload: {} });
  assert.equal(noKeys.statusCode, 409);
  assert.equal(noKeys.json().error, "not_configured");
  const badToken = await s.app.inject({ method: "POST", url: "/api/scrobblers/listenbrainz/connect", headers: s.alice, payload: { token: "x" } });
  assert.equal(badToken.statusCode, 400);
  const maloja = await s.app.inject({ method: "POST", url: "/api/scrobblers/maloja/connect", headers: s.alice, payload: { url: "https://m.example", apiKey: "k" } });
  assert.equal(maloja.statusCode, 403);
  const finishLb = await s.app.inject({ method: "POST", url: "/api/scrobblers/listenbrainz/finish", headers: s.alice });
  assert.equal(finishLb.statusCode, 400);
  const notConnected = await s.app.inject({ method: "POST", url: "/api/scrobblers/listenbrainz/test", headers: s.alice });
  assert.equal(notConnected.statusCode, 409);
  await s.app.close();
});
