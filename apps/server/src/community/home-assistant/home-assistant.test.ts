import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { bearer, startTestServer, type TestServer } from "../_devices/testkit.js";
import { openSse, type SseStream } from "../_devices/sseClient.js";
import { DeviceHub } from "../_devices/deviceHub.js";
import { createRemoteControlPlugin } from "../remote-control/plugin.js";
import { createHomeAssistantPlugin } from "./plugin.js";
import { startFakeHa, type FakeHa } from "./fakeHa.js";
import { open, seal } from "./secretBox.js";
import { commandFromBody } from "./commands.js";

const hub = new DeviceHub();
let ha: FakeHa;
let srv: TestServer;
let base = "";
let player: SseStream;
let commandToken = "";
const PLAYER = "alice-laptop-0001";
const track = { id: "server:abc", title: "Song", artists: [{ id: "a", name: "Artist" }], album: "Album", durationSec: 200 };

before(async () => {
  ha = await startFakeHa();
  srv = await startTestServer([createRemoteControlPlugin({ hub }), createHomeAssistantPlugin({ hub, refreshMs: 60_000 })]);
  await srv.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(srv.app.server.address() as AddressInfo).port}`;
});

after(async () => {
  player?.close();
  await srv.cleanup();
  await ha.close();
});

const call = (method: "GET" | "POST" | "PUT" | "DELETE", path: string, token: string, payload?: unknown) =>
  srv.app.inject({ method, url: `/api/home-assistant${path}`, headers: bearer(token), payload: payload as object });
const report = (state: Record<string, unknown>) =>
  srv.app.inject({
    method: "POST",
    url: "/api/remote-control/state",
    headers: bearer(srv.alice),
    payload: { deviceId: PLAYER, state: { track, duration: 200, volume: 0.5, queue: [track], index: 0, ...state } },
  });
/** Only used to show that nothing is sent: a slow machine can make these checks weaker, never fail. */
const settle = () => new Promise((r) => setTimeout(r, 150));

test("the token is validated, stored encrypted and never returned", async () => {
  assert.equal((await call("PUT", "/config", srv.alice, { url: "ftp://nope" })).statusCode, 400);
  assert.equal((await call("PUT", "/config", srv.alice, { entityId: "Not An Entity" })).statusCode, 400);
  const res = await call("PUT", "/config", srv.alice, { url: `${ha.url}/`, token: ha.token });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    { url: res.json().url, hasToken: res.json().hasToken, entityId: res.json().entityId },
    { url: ha.url, hasToken: true, entityId: "media_player.cadence_alice" },
  );
  assert.ok(!res.body.includes(ha.token));
  const raw = srv.db.prepare("SELECT value FROM settings WHERE key LIKE '%home-assistant%user%'").all() as { value: string }[];
  assert.ok(raw.length > 0 && raw.every((r) => !r.value.includes(ha.token)), "token is not stored in plain text");
  assert.equal(open("s".repeat(64), seal("s".repeat(64), "abc")), "abc");
  assert.equal(open("other-secret", seal("s".repeat(64), "abc")), null);
});

test("the connection test updates the entity, and a wrong token is explained", async () => {
  const ok = await call("POST", "/test", srv.alice);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ha.states.get("media_player.cadence_alice")?.state, "off");
  assert.equal((await call("POST", "/test", srv.bob)).statusCode, 409);
  await call("PUT", "/config", srv.alice, { token: "wrong" });
  const bad = await call("POST", "/test", srv.alice);
  assert.equal(bad.statusCode, 502);
  assert.match(bad.json().message, /rejected the token/);
  await call("PUT", "/config", srv.alice, { token: ha.token });
});

test("playing state is pushed to Home Assistant with the official REST call", async () => {
  player = await openSse(`${base}/api/remote-control/stream?deviceId=${PLAYER}&name=Laptop&kind=desktop`, srv.alice);
  await player.waitFor("hello");
  ha.posts.length = 0;
  assert.equal((await report({ isPlaying: true, position: 10 })).statusCode, 200);
  await ha.waitForPost((p) => p.body.state === "playing", 0);
  const playing = ha.states.get("media_player.cadence_alice")!;
  assert.equal(playing.state, "playing");
  assert.equal(playing.attributes["media_title"], "Song");
  assert.equal(playing.attributes["media_artist"], "Artist");
  assert.equal(playing.attributes["media_album_name"], "Album");
  assert.equal(playing.attributes["media_position"], 10);
  assert.equal(playing.attributes["source"], "Laptop");
  assert.match(String(playing.attributes["media_position_updated_at"]), /^\d{4}-\d\d-\d\dT/);
  const mark = ha.posts.length;
  await report({ isPlaying: false, position: 11 });
  await ha.waitForPost((p) => p.body.state === "paused", mark);
  assert.equal(ha.states.get("media_player.cadence_alice")?.state, "paused");
});

test("routine progress reports are not pushed, but a seek is", async () => {
  const mark = ha.posts.length;
  await report({ isPlaying: true, position: 20 });
  await ha.waitForPost((p) => p.body.state === "playing" && p.body.attributes["media_position"] === 20, mark);
  const before = ha.posts.length;
  await report({ isPlaying: true, position: 21 });
  await report({ isPlaying: true, position: 22 });
  await settle();
  assert.equal(ha.posts.length, before, "on-track progress does not spam Home Assistant");
  await report({ isPlaying: true, position: 150 });
  await ha.waitForPost((p) => p.body.attributes["media_position"] === 150, before);
  assert.equal(ha.posts.length, before + 1);
  assert.equal(ha.states.get("media_player.cadence_alice")?.attributes["media_position"], 150);
});


test("a command token is shown once, stored only as a hash, and can be revoked", async () => {
  const res = await call("POST", "/command-token", srv.alice);
  commandToken = res.json().token;
  assert.match(commandToken, /^cadha_[\w-]{40,}$/);
  const raw = srv.db.prepare("SELECT value FROM settings WHERE key LIKE '%home-assistant%user%'").all() as { value: string }[];
  assert.ok(raw.every((r) => !r.value.includes(commandToken)));
  assert.equal((await call("GET", "/config", srv.alice)).json().hasCommandToken, true);
  assert.ok(!(await call("GET", "/config", srv.alice)).body.includes(commandToken));
});

test("Home Assistant commands are token authenticated and reach the right player", async () => {
  const send = (body: unknown, token = commandToken) =>
    srv.app.inject({ method: "POST", url: "/api/home-assistant/command", headers: bearer(token), payload: body as object });
  assert.equal((await send({ command: "pause" }, "cadha_nope")).statusCode, 401);
  assert.equal((await send({ command: "pause" }, srv.alice)).statusCode, 401, "a login session is not a command token");
  assert.equal((await srv.app.inject({ method: "POST", url: "/api/home-assistant/command", payload: { command: "pause" } })).statusCode, 401);

  const ok = await send({ command: "pause" });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().device, "Laptop");
  assert.deepEqual((await player.waitFor("command", (d) => d.command.type === "pause")).command, { type: "pause" });

  await send({ command: "media_next_track" });
  await player.waitFor("command", (d) => d.command.type === "next");
  await send({ command: "seek", position: 95 });
  await player.waitFor("command", (d) => d.command.type === "seek" && d.command.position === 95);
  await send({ command: "volume_set", volume_level: 0.3, device: "laptop" });
  await player.waitFor("command", (d) => d.command.type === "volume" && d.command.volume === 0.3);
  await send({ command: "volume_up" });
  const up = await player.waitFor("command", (d) => d.command.type === "volume" && d.command.volume > 0.4);
  assert.equal(up.command.volume, 0.6);

  assert.equal((await send({ command: "explode" })).statusCode, 400);
  assert.equal((await send({ command: "seek" })).statusCode, 400);
  const unknown = await send({ command: "play", device: "Kitchen" });
  assert.equal(unknown.statusCode, 409);
  assert.equal(unknown.json().error, "no_player");
});

test("the polling endpoint returns the current state and each user only controls their own players", async () => {
  const now = await srv.app.inject({ method: "GET", url: "/api/home-assistant/now-playing", headers: bearer(commandToken) });
  assert.equal(now.statusCode, 200);
  assert.equal(now.json().attributes.media_title, "Song");
  const bobToken = (await call("POST", "/command-token", srv.bob)).json().token;
  const bobSend = await srv.app.inject({ method: "POST", url: "/api/home-assistant/command", headers: bearer(bobToken), payload: { command: "pause" } });
  assert.equal(bobSend.statusCode, 409, "bob has no player; alice's is not reachable with his token");
  const bobNow = await srv.app.inject({ method: "GET", url: "/api/home-assistant/now-playing", headers: bearer(bobToken) });
  assert.equal(bobNow.json().state, "off");
});

test("repeated bad tokens are rate limited, and a revoked token stops working", async () => {
  const bad = () => srv.app.inject({ method: "POST", url: "/api/home-assistant/command", headers: bearer("cadha_guess"), payload: { command: "pause" } });
  let last = 0;
  for (let i = 0; i < 25; i++) last = (await bad()).statusCode;
  assert.equal(last, 429);
  assert.equal((await call("DELETE", "/command-token", srv.alice)).json().hasCommandToken, false);
});

test("going offline tells Home Assistant, and a failing Home Assistant is backed off", async () => {
  const mark = ha.posts.length;
  player.close();
  await ha.waitForPost((p) => p.body.state === "off", mark);
  assert.equal(ha.states.get("media_player.cadence_alice")?.state, "off");
  // A new player while Home Assistant is down: one failed attempt, then no retry storm.
  ha.setFailing(500);
  const before = ha.posts.length;
  const again = await openSse(`${base}/api/remote-control/stream?deviceId=${PLAYER}&name=Laptop&kind=desktop`, srv.alice);
  await again.waitFor("hello");
  await report({ isPlaying: true, position: 1 });
  await settle();
  await report({ isPlaying: false, position: 1 });
  await settle();
  ha.setFailing(null);
  assert.equal(ha.posts.length, before);
  again.close();
});

test("command names map to player commands", () => {
  assert.deepEqual(commandFromBody({ command: "media_play_pause" }, null), { type: "toggle" });
  assert.deepEqual(commandFromBody({ command: "media_previous_track" }, null), { type: "previous" });
  assert.deepEqual(commandFromBody({ command: "volume_set", volume_level: 5 }, null), { type: "volume", volume: 1 });
  assert.equal(commandFromBody({ command: "volume_set" }, null), null);
  assert.equal(commandFromBody({}, null), null);
});

test("without the remote-control plugin commands explain what is missing", async () => {
  const lonely = await startTestServer([createHomeAssistantPlugin({ hub: new DeviceHub() })]);
  const token = (await lonely.app.inject({ method: "POST", url: "/api/home-assistant/command-token", headers: bearer(lonely.alice) })).json().token;
  const res = await lonely.app.inject({ method: "POST", url: "/api/home-assistant/command", headers: bearer(token), payload: { command: "pause" } });
  assert.equal(res.statusCode, 503);
  assert.match(res.json().message, /Remote control/);
  await lonely.cleanup();
});
