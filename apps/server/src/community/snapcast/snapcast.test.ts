import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { bearer, startTestServer, type TestServer } from "../_devices/testkit.js";
import { startFakeSnapserver, type FakeSnapserver } from "./fakeSnapserver.js";
import { createSnapcastPlugin } from "./plugin.js";
import { parseSnapAddress } from "./rpc.js";

let snap: FakeSnapserver;
let srv: TestServer;

before(async () => {
  snap = await startFakeSnapserver();
  srv = await startTestServer([createSnapcastPlugin({ timeoutMs: 1500 })]);
});

after(async () => {
  await srv.cleanup();
  await snap.close();
});

const get = (url: string, token = srv.alice) => srv.app.inject({ method: "GET", url, headers: bearer(token) });
const post = (url: string, payload: unknown = {}, token = srv.alice) =>
  srv.app.inject({ method: "POST", url, headers: bearer(token), payload: payload as object });
const put = (payload: unknown, token = srv.admin) =>
  srv.app.inject({ method: "PUT", url: "/api/snapcast/config", headers: bearer(token), payload: payload as object });
const lastCall = (method: string) => snap.calls.filter((c) => c.method === method).at(-1);

test("addresses parse to TCP or HTTP endpoints, and junk is rejected", () => {
  assert.deepEqual(parseSnapAddress("192.168.1.5"), { kind: "tcp", host: "192.168.1.5", port: 1705 });
  assert.deepEqual(parseSnapAddress("snap.local:1799"), { kind: "tcp", host: "snap.local", port: 1799 });
  assert.equal(parseSnapAddress("http://192.168.1.5:1780")?.kind, "http");
  assert.equal(parseSnapAddress("javascript:alert(1)"), null);
  assert.equal(parseSnapAddress("http://169.254.169.254/"), null);
});

test("before configuration the status says so, and only an admin can configure", async () => {
  assert.equal((await get("/api/snapcast/status")).json().configured, false);
  assert.equal((await post("/api/snapcast/groups/g1/mute", { muted: true })).statusCode, 409);
  assert.equal((await put({ address: `127.0.0.1:${snap.tcpPort}` }, srv.alice)).statusCode, 403);
  assert.equal((await put({ address: "ftp://x" })).statusCode, 400);
  assert.equal((await put({ address: `127.0.0.1:${snap.tcpPort}` })).statusCode, 200);
});

test("status lists groups, clients and streams over TCP, skipping notifications", async () => {
  const body = (await get("/api/snapcast/status")).json();
  assert.equal(body.configured, true);
  assert.equal(body.serverVersion, "0.27.0");
  assert.equal(body.groups.length, 2);
  assert.deepEqual(body.groups[0].clients[0], { id: "aa:bb", name: "Kitchen", host: "kitchen-pi", connected: true, volume: 60, muted: false });
  assert.equal(body.groups[0].clients[1].name, "den-pi");
  assert.equal(body.groups[0].clients[1].connected, false);
  assert.deepEqual(body.streams, [{ id: "default", status: "playing" }, { id: "spotify", status: "idle" }]);
});

test("volume, mute and stream changes reach the Snapcast server with the right method", async () => {
  assert.equal((await post("/api/snapcast/clients/aa:bb/volume", { percent: 85 })).statusCode, 200);
  assert.deepEqual(lastCall("Client.SetVolume")!.params, { id: "aa:bb", volume: { percent: 85, muted: false } });
  assert.equal((await post("/api/snapcast/clients/aa:bb/mute", { muted: true })).statusCode, 200);
  assert.deepEqual(lastCall("Client.SetVolume")!.params, { id: "aa:bb", volume: { percent: 85, muted: true } });
  assert.equal((await post("/api/snapcast/groups/g1/mute", { muted: true })).statusCode, 200);
  assert.deepEqual(lastCall("Group.SetMute")!.params, { id: "g1", mute: true });
  assert.equal((await post("/api/snapcast/groups/g1/stream", { streamId: "spotify" })).statusCode, 200);
  assert.deepEqual(lastCall("Group.SetStream")!.params, { id: "g1", stream_id: "spotify" });
  // The fake does not implement Group.SetClients; the request still has to be well formed.
  assert.equal((await post("/api/snapcast/groups/g2/clients", { clients: ["aa:bb", "cc:dd"] })).statusCode, 502);
  assert.deepEqual(lastCall("Group.SetClients")!.params, { id: "g2", clients: ["aa:bb", "cc:dd"] });
  assert.equal((await get("/api/snapcast/status")).json().groups[0].clients[0].volume, 85);
});

test("bad input is rejected before it reaches the server", async () => {
  const count = snap.calls.length;
  assert.equal((await post("/api/snapcast/clients/aa:bb/volume", { percent: "loud" })).statusCode, 400);
  assert.equal((await post("/api/snapcast/groups/g1/mute", { muted: "yes" })).statusCode, 400);
  assert.equal((await post("/api/snapcast/groups/bad id!/mute", { muted: true })).statusCode, 400);
  assert.equal((await post("/api/snapcast/groups/g1/stream", { streamId: "../x" })).statusCode, 400);
  assert.equal(snap.calls.length, count);
  const unknown = await post("/api/snapcast/clients/zz:zz/mute", { muted: true });
  assert.equal(unknown.statusCode, 502);
  assert.match(unknown.json().message, /not found/);
});

test("the HTTP JSON-RPC endpoint works too", async () => {
  assert.equal((await put({ address: `http://127.0.0.1:${snap.httpPort}` })).statusCode, 200);
  assert.equal((await get("/api/snapcast/status")).json().groups.length, 2);
  assert.equal((await post("/api/snapcast/groups/g2/mute", { muted: false })).statusCode, 200);
  assert.deepEqual(lastCall("Group.SetMute")!.params, { id: "g2", mute: false });
});

test("an unreachable server gives a short error and the address can be cleared", async () => {
  assert.equal((await put({ address: "127.0.0.1:1" })).statusCode, 200);
  const res = await get("/api/snapcast/status");
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, "device_error");
  assert.equal((await get("/api/snapcast/status", "bad-token")).statusCode, 401);
  assert.equal((await put({ address: null })).json().address, null);
  assert.equal((await get("/api/snapcast/status")).json().configured, false);
});
