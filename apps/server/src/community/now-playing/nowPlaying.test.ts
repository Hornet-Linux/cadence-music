import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import type { AuthResponse } from "@uma/shared";
import { buildApp } from "../../app.js";
import { createLocalUser } from "../../auth/users.js";
import { openDb } from "../../db.js";
import { OVERLAY_CSP, OVERLAY_HTML } from "./overlay.js";
import {
  EMPTY_SNAPSHOT,
  NowPlayingHub,
  PAUSED_VISIBLE_MS,
  PLAYING_STALE_MS,
  parseHeartbeat,
  publicHttpsUrl,
  snapshotOf,
  type Heartbeat,
} from "./nowPlaying.js";
import nowPlayingPlugin from "./plugin.js";

const track = { id: "server:1", title: "Song", artists: [{ id: "a", name: "Artist" }], album: "Album", artwork: "https://i.scdn.co/image/x" };
const beat = (over: Partial<Heartbeat> = {}): Heartbeat => ({
  state: "playing",
  track: { id: "1", title: "Song", artists: ["Artist"] },
  positionSec: 10,
  durationSec: 200,
  receivedAt: 1_000_000,
  ...over,
});

test("heartbeats are validated, and artwork must be a public https image", () => {
  const now = 5;
  assert.equal(parseHeartbeat(null, now), null);
  assert.equal(parseHeartbeat({ state: "dancing" }, now), null);
  assert.equal(parseHeartbeat({ state: "playing", track: { id: "x" } }, now), null, "title is required");
  assert.deepEqual(parseHeartbeat({ state: "stopped" }, now), { state: "stopped", positionSec: 0, durationSec: 0, receivedAt: now });
  const ok = parseHeartbeat({ state: "playing", track, positionSec: 12.34, durationSec: 200 }, now)!;
  assert.equal(ok.track!.artists[0], "Artist");
  assert.equal(ok.track!.artwork, "https://i.scdn.co/image/x");
  assert.equal(ok.positionSec, 12.3);
  for (const bad of [
    "http://example.com/a.png",
    "https://localhost/a.png",
    "https://192.168.1.5/a.png",
    "https://10.1.1.1/a.png",
    "https://nas.local/a.png",
    "https://u:p@example.com/a.png",
    "javascript:alert(1)",
    "https://intranet/a.png",
  ]) {
    assert.equal(publicHttpsUrl(bad), undefined, bad);
  }
  const sneaky = parseHeartbeat({ state: "paused", track: { ...track, artwork: "https://127.0.0.1/a.png" }, positionSec: -4, durationSec: "x" }, now)!;
  assert.equal(sneaky.track!.artwork, undefined);
  assert.equal(sneaky.positionSec, 0);
  assert.equal(sneaky.durationSec, 0);
});

test("a playing song advances with time and goes stale when heartbeats stop", () => {
  const b = beat();
  assert.equal(snapshotOf(b, b.receivedAt + 5000).positionSec, 15);
  assert.equal(snapshotOf(b, b.receivedAt + 5000).active, true);
  assert.equal(snapshotOf(b, b.receivedAt + PLAYING_STALE_MS + 1), EMPTY_SNAPSHOT);
  assert.equal(snapshotOf(beat({ positionSec: 199 }), b.receivedAt + 30_000).positionSec, 200, "never past the end");
  assert.equal(snapshotOf(undefined, 0), EMPTY_SNAPSHOT);
  assert.equal(snapshotOf(beat({ state: "stopped" }), b.receivedAt), EMPTY_SNAPSHOT);
});

test("a paused song holds its position and stays visible for a few minutes", () => {
  const b = beat({ state: "paused" });
  const s = snapshotOf(b, b.receivedAt + 60_000);
  assert.equal(s.active, true);
  assert.equal(s.playing, false);
  assert.equal(s.positionSec, 10);
  assert.equal(snapshotOf(b, b.receivedAt + PAUSED_VISIBLE_MS + 1), EMPTY_SNAPSHOT);
});

test("the hub reaches only the right person's overlays and drops a revoked one", () => {
  const hub = new NowPlayingHub();
  const seen: string[] = [];
  let closed = 0;
  hub.subscribe(1, { tokenId: 10, send: (s) => void seen.push(`a:${s.title}`), close: () => void closed++ });
  hub.subscribe(2, { tokenId: 20, send: (s) => void seen.push(`b:${s.title}`), close: () => void closed++ });
  hub.update(1, beat({ receivedAt: Date.now() }));
  assert.deepEqual(seen, ["a:Song"]);
  assert.equal(hub.countFor(1), 1);
  hub.dropToken(1, 10);
  assert.equal(closed, 1);
});

test("the overlay page script is valid JavaScript and never uses innerHTML", () => {
  const script = /<script>([\s\S]*)<\/script>/.exec(OVERLAY_HTML)![1]!;
  assert.doesNotThrow(() => new vm.Script(script), "overlay script must parse");
  assert.ok(!/innerHTML|document\.write|eval\(/.test(script));
  assert.match(script, /\^https:\\\/\\\//, "keeps its https-only image check");
  assert.match(OVERLAY_HTML, /background: transparent/);
  assert.match(OVERLAY_CSP, /connect-src 'self'/);
});

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-np-"));
  const db = openDb(":memory:");
  await createLocalUser(db, { username: "alice", password: "alice-password" });
  await createLocalUser(db, { username: "bob", password: "bob-password" });
  const app = await buildApp({
    config: { host: "127.0.0.1", port: 0, dataDir: dir, musicDir: dir, scanIntervalMinutes: 0, trustProxy: false, logLevel: "silent" },
    db,
    secret: "s".repeat(64),
    logger: false,
    plugins: [nowPlayingPlugin],
  });
  const signIn = async (username: string, password: string) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
    return { authorization: `Bearer ${(res.json() as AuthResponse).token}` };
  };
  return { app, alice: await signIn("alice", "alice-password"), bob: await signIn("bob", "bob-password") };
}

test("only signed-in players can send heartbeats, and bad ones are refused", async () => {
  const { app, alice } = await setup();
  const payload = { state: "playing", track, positionSec: 5, durationSec: 100 };
  assert.equal((await app.inject({ method: "POST", url: "/api/now-playing", payload })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/now-playing", headers: alice, payload: { state: "?" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/now-playing", headers: alice, payload })).statusCode, 204);
  const mine = (await app.inject({ method: "GET", url: "/api/now-playing", headers: alice })).json() as { title: string; active: boolean };
  assert.equal(mine.title, "Song");
  assert.equal(mine.active, true);
  await app.close();
});

test("overlay links are secret, unguessable, shown once, and show only their owner's song", async () => {
  const { app, alice, bob } = await setup();
  assert.equal((await app.inject({ method: "POST", url: "/api/now-playing/tokens", payload: {} })).statusCode, 401);
  const created = await app.inject({ method: "POST", url: "/api/now-playing/tokens", headers: alice, payload: { label: "Stream" } });
  assert.equal(created.statusCode, 201);
  const { token, id } = created.json() as { token: string; id: number };
  assert.match(token, /^np_[A-Za-z0-9_-]{32}$/);
  const other = ((await app.inject({ method: "POST", url: "/api/now-playing/tokens", headers: alice, payload: {} })).json() as { token: string }).token;
  assert.notEqual(token, other);

  const list = (await app.inject({ method: "GET", url: "/api/now-playing/tokens", headers: alice })).json() as { tokens: { id: number; label: string }[] };
  assert.equal(list.tokens.length, 2);
  assert.ok(!JSON.stringify(list).includes(token), "the secret is never listed again");

  await app.inject({ method: "POST", url: "/api/now-playing", headers: alice, payload: { state: "playing", track, positionSec: 5, durationSec: 100 } });
  await app.inject({
    method: "POST",
    url: "/api/now-playing",
    headers: bob,
    payload: { state: "playing", track: { ...track, title: "Bob's song" }, positionSec: 0, durationSec: 100 },
  });

  const page = await app.inject({ method: "GET", url: `/overlay/${token}` });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers["content-type"] as string, /text\/html/);
  assert.equal(page.headers["content-security-policy"], OVERLAY_CSP);
  assert.equal(page.headers["referrer-policy"], "no-referrer");
  assert.ok(!page.body.includes(token), "the page does not repeat the secret");

  const now = (await app.inject({ method: "GET", url: `/overlay/${token}/now` })).json() as { title: string; artwork: string };
  assert.equal(now.title, "Song", "alice's link shows alice's song, not bob's");
  assert.equal(now.artwork, "https://i.scdn.co/image/x");

  for (const bad of ["np_" + "a".repeat(32), "short", "np_%00", token + "x", token.slice(0, -1)]) {
    assert.equal((await app.inject({ method: "GET", url: `/overlay/${encodeURIComponent(bad)}` })).statusCode, 404, bad);
    assert.equal((await app.inject({ method: "GET", url: `/overlay/${encodeURIComponent(bad)}/now` })).statusCode, 404, bad);
  }

  // Revoking stops the link working; someone else cannot revoke it.
  assert.equal((await app.inject({ method: "DELETE", url: `/api/now-playing/tokens/${id}`, headers: bob })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/overlay/${token}` })).statusCode, 200);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/now-playing/tokens/${id}`, headers: alice })).statusCode, 204);
  assert.equal((await app.inject({ method: "GET", url: `/overlay/${token}` })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/overlay/${other}` })).statusCode, 200, "other links keep working");
  await app.close();
});

test("a person can have only a few links", async () => {
  const { app, alice } = await setup();
  for (let i = 0; i < 10; i++) {
    assert.equal((await app.inject({ method: "POST", url: "/api/now-playing/tokens", headers: alice, payload: {} })).statusCode, 201);
  }
  assert.equal((await app.inject({ method: "POST", url: "/api/now-playing/tokens", headers: alice, payload: {} })).statusCode, 409);
  await app.close();
});

test("the overlay updates live over server-sent events and ends when the link is revoked", async () => {
  const { app, alice } = await setup();
  const created = (await app.inject({ method: "POST", url: "/api/now-playing/tokens", headers: alice, payload: {} })).json() as { token: string; id: number };
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as { port: number }).port;

  const messages: { title: string; active: boolean }[] = [];
  let ended = false;
  await new Promise<void>((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: `/overlay/${created.token}/events` }, (res) => {
      assert.equal(res.statusCode, 200);
      assert.match(res.headers["content-type"] as string, /text\/event-stream/);
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        for (;;) {
          const end = buf.indexOf("\n\n");
          if (end < 0) break;
          const block = buf.slice(0, end);
          buf = buf.slice(end + 2);
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (line) messages.push(JSON.parse(line.slice(6)));
          if (messages.length === 1) {
            // Initial (idle) snapshot arrived: now play something.
            void app.inject({ method: "POST", url: "/api/now-playing", headers: alice, payload: { state: "playing", track, positionSec: 1, durationSec: 60 } });
          } else if (messages.length === 2) {
            void app.inject({ method: "DELETE", url: `/api/now-playing/tokens/${created.id}`, headers: alice });
          }
        }
      });
      res.on("end", () => {
        ended = true;
        resolve();
      });
    });
    req.on("error", reject);
    setTimeout(() => reject(new Error("timed out waiting for the stream")), 8000).unref();
  });
  assert.deepEqual(
    messages.map((m) => [m.active, m.title]),
    [
      [false, ""],
      [true, "Song"],
    ],
  );
  assert.ok(ended, "revoking closes open streams");
  await app.close();
});