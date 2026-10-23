import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { bearer, startTestServer, type TestServer } from "../_devices/testkit.js";
import { openSse, type SseStream } from "../_devices/sseClient.js";
import { DeviceHub } from "../_devices/deviceHub.js";
import { cleanCommand, cleanState } from "../_devices/hub.js";
import { createRemoteControlPlugin } from "./plugin.js";

const hub = new DeviceHub();
let srv: TestServer;
let base = "";
const open: SseStream[] = [];

const PHONE = "phone-0000-aaaa";
const LAPTOP = "laptop-0000-bbbb";

before(async () => {
  srv = await startTestServer([createRemoteControlPlugin({ hub, keepAliveMs: 200 })]);
  await srv.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(srv.app.server.address() as AddressInfo).port}`;
});

after(async () => {
  for (const s of open) s.close();
  await srv.cleanup();
});

const connect = async (token: string, deviceId: string, name: string, kind = "web") => {
  const s = await openSse(`${base}/api/remote-control/stream?deviceId=${deviceId}&name=${encodeURIComponent(name)}&kind=${kind}`, token);
  open.push(s);
  return s;
};
const post = (path: string, payload: unknown, token: string) =>
  srv.app.inject({ method: "POST", url: `/api/remote-control${path}`, headers: bearer(token), payload: payload as object });
const track = { id: "server:abc", title: "Song", artists: [{ id: "a", name: "Artist" }], durationSec: 200 };

test("streams and commands need a signed-in user and a valid device id", async () => {
  assert.equal((await srv.app.inject({ method: "GET", url: `/api/remote-control/stream?deviceId=${PHONE}` })).statusCode, 401);
  assert.equal((await srv.app.inject({ method: "GET", url: "/api/remote-control/stream?deviceId=x", headers: bearer(srv.alice) })).statusCode, 400);
  assert.equal((await post(`/devices/${LAPTOP}/command`, { command: { type: "play" } }, "nope")).statusCode, 401);
});

test("two devices see each other and the list updates as they come and go", async () => {
  const laptop = await connect(srv.alice, LAPTOP, "Laptop", "desktop");
  const hello = await laptop.waitFor("hello");
  assert.equal(hello.devices.length, 1);
  const phone = await connect(srv.alice, PHONE, "Phone", "phone");
  const seen = await laptop.waitFor("devices", (d) => d.devices.length === 2);
  assert.deepEqual(seen.devices.map((d: { name: string; online: boolean; kind: string }) => [d.name, d.online, d.kind]), [
    ["Laptop", true, "desktop"],
    ["Phone", true, "phone"],
  ]);
  await phone.waitFor("devices", (d) => d.devices.length === 2);
});

test("a command is relayed only to the target device", async () => {
  const [laptop, phone] = open as [SseStream, SseStream];
  const res = await post(`/devices/${LAPTOP}/command`, { command: { type: "seek", position: 61 }, from: PHONE }, srv.alice);
  assert.equal(res.statusCode, 202);
  const got = await laptop.waitFor("command", (d) => d.command.type === "seek");
  assert.deepEqual(got, { command: { type: "seek", position: 61 }, from: PHONE });
  assert.equal(phone.events.filter((e) => e.event === "command").length, 0);
  for (const command of [{ type: "pause" }, { type: "next" }, { type: "volume", volume: 2 }, { type: "queue.play", tracks: [track], index: 0, position: 12 }]) {
    assert.equal((await post(`/devices/${LAPTOP}/command`, { command }, srv.alice)).statusCode, 202);
  }
  const volume = await laptop.waitFor("command", (d) => d.command.type === "volume");
  assert.equal(volume.command.volume, 1, "volume is clamped");
  const queue = await laptop.waitFor("command", (d) => d.command.type === "queue.play");
  assert.equal(queue.command.tracks[0].id, "server:abc");
  assert.equal(queue.command.play, true);
});

test("state reported by one device reaches the others but not itself", async () => {
  const [laptop, phone] = open as [SseStream, SseStream];
  const state = { track, isPlaying: true, position: 33, duration: 200, volume: 0.5, queue: [track, track], index: 0 };
  assert.equal((await post("/state", { deviceId: LAPTOP, state }, srv.alice)).statusCode, 200);
  const got = await phone.waitFor("state", (d) => d.device.id === LAPTOP);
  assert.equal(got.device.state.position, 33);
  assert.equal(got.device.state.track.title, "Song");
  assert.equal(laptop.events.filter((e) => e.event === "state").length, 0);
  const list = (await srv.app.inject({ method: "GET", url: "/api/remote-control/devices", headers: bearer(srv.alice) })).json();
  assert.equal(list.devices.find((d: { id: string }) => d.id === LAPTOP).state.isPlaying, true);
  assert.equal((await post("/state", { deviceId: LAPTOP, state: "junk" }, srv.alice)).statusCode, 400);
});

test("another user sees nothing of alice's devices and cannot command or spoof them", async () => {
  const bobList = (await srv.app.inject({ method: "GET", url: "/api/remote-control/devices", headers: bearer(srv.bob) })).json();
  assert.deepEqual(bobList.devices, []);
  assert.equal((await post(`/devices/${LAPTOP}/command`, { command: { type: "pause" } }, srv.bob)).statusCode, 404);
  assert.equal((await post("/state", { deviceId: LAPTOP, state: { isPlaying: true } }, srv.bob)).statusCode, 404);
  const bobPhone = await connect(srv.bob, "bobs-phone-0001", "Bob phone");
  const hello = await bobPhone.waitFor("hello");
  assert.deepEqual(hello.devices.map((d: { id: string }) => d.id), ["bobs-phone-0001"]);
  // Bob reusing alice's device id gets his own, separate device.
  const sameId = await connect(srv.bob, LAPTOP, "Bob laptop");
  await sameId.waitFor("hello");
  const [aliceLaptop] = open as [SseStream];
  assert.equal(aliceLaptop.events.filter((e) => e.event === "replaced").length, 0, "alice's device was not replaced");
  assert.equal((await post(`/devices/${LAPTOP}/command`, { command: { type: "pause" } }, srv.alice)).statusCode, 202);
  assert.equal(sameId.events.filter((e) => e.event === "command").length, 0);
});

test("reconnecting with the same device id replaces the old stream and keeps the device online", async () => {
  const [laptop, phone] = open as [SseStream, SseStream];
  const again = await connect(srv.alice, LAPTOP, "Laptop renamed", "desktop");
  await again.waitFor("hello");
  await laptop.waitFor("replaced");
  await laptop.closed;
  const devices = await phone.waitFor("devices", (d) => d.devices.some((x: { name: string }) => x.name === "Laptop renamed"));
  assert.equal(devices.devices.find((d: { id: string }) => d.id === LAPTOP).online, true);
  assert.equal(devices.devices.length, 2);
  // The command still arrives on the new stream, and the old stream ending did not take the device offline.
  assert.equal((await post(`/devices/${LAPTOP}/command`, { command: { type: "play" } }, srv.alice)).statusCode, 202);
  await again.waitFor("command", (d) => d.command.type === "play");
  const kept = (await srv.app.inject({ method: "GET", url: "/api/remote-control/devices", headers: bearer(srv.alice) })).json();
  assert.equal(kept.devices.find((d: { id: string }) => d.id === LAPTOP).state.position, 33, "state survives a reconnect");
});

test("a device that goes away shows as offline and cannot be commanded until it returns", async () => {
  const phone = open[1]!;
  const laptop = open.at(-1)!;
  // open.at(-1) is bob's laptop; alice's second laptop stream is the one before the last two bob streams.
  const aliceLaptop = open.find((s, i) => i > 1 && s.events.some((e) => e.event === "hello" && (e.data as { devices: { name: string }[] }).devices.some((d) => d.name === "Laptop renamed")))!;
  assert.ok(aliceLaptop && laptop);
  aliceLaptop.close();
  const offline = await phone.waitFor("devices", (d) => d.devices.some((x: { id: string; online: boolean }) => x.id === LAPTOP && !x.online));
  assert.equal(offline.devices.length, 2);
  const res = await post(`/devices/${LAPTOP}/command`, { command: { type: "play" } }, srv.alice);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "device_offline");
  assert.equal((await post("/devices/nonexistent-device/command", { command: { type: "play" } }, srv.alice)).statusCode, 404);
  const back = await connect(srv.alice, LAPTOP, "Laptop", "desktop");
  await back.waitFor("hello");
  await phone.waitFor("devices", (d) => d.devices.some((x: { id: string; online: boolean }) => x.id === LAPTOP && x.online));
});

test("keep-alive comments flow so idle proxies do not drop the stream", async () => {
  const res = await fetch(`${base}/api/remote-control/stream?deviceId=keepalive-0001`, { headers: bearer(srv.alice) });
  const reader = res.body!.getReader();
  let text = "";
  const deadline = Date.now() + 2000;
  while (!text.includes("keep-alive") && Date.now() < deadline) text += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.match(text, /: keep-alive/);
});

test("malformed commands and states are rejected or bounded", () => {
  assert.equal(cleanCommand({ type: "explode" }), null);
  assert.equal(cleanCommand({ type: "seek", position: -1 }), null);
  assert.equal(cleanCommand({ type: "seek", position: "1" }), null);
  assert.equal(cleanCommand({ type: "queue.play", tracks: [], index: 0 }), null);
  assert.equal(cleanCommand({ type: "queue.add", track: { id: "", title: "x" } }), null);
  const state = cleanState({ track, queue: Array.from({ length: 500 }, () => track), volume: 9, position: -4, index: 2.7 })!;
  assert.equal(state.queue.length, 200);
  assert.equal(state.volume, 1);
  assert.equal(state.position, 0);
  assert.equal(state.index, 2);
  const long = cleanState({ track: { ...track, title: "x".repeat(5000), artwork: "javascript:alert(1)" } })!;
  assert.equal(long.track!.title.length, 300);
  assert.equal(long.track!.artwork, undefined);
});

test("devices offline longer than the grace period are forgotten", () => {
  let now = 1_000_000;
  const h = new DeviceHub(() => now);
  const sent: string[] = [];
  const end = h.connect(7, { id: "dev-aaaaaaaa", name: "A", kind: "web" }, { send: (e) => sent.push(e), close: () => undefined });
  end();
  assert.equal(h.list(7).length, 1);
  assert.equal(h.list(7)[0]!.online, false);
  now += 91_000;
  assert.equal(h.list(7).length, 0);
  assert.equal(h.activeDevice(7), null);
});
