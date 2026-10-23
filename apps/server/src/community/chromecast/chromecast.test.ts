import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { bearer, startTestServer, type TestServer } from "../_devices/testkit.js";
import { FrameReader, decodeCastMessage, encodeCastMessage, frame } from "./castMessage.js";
import { castServicesFrom, readName } from "./mdns.js";
import { castAnnouncement, startFakeCast, type FakeCast } from "./fakeCast.js";
import { createChromecastPlugin } from "./plugin.js";

let cast: FakeCast;
let srv: TestServer;

before(async () => {
  cast = await startFakeCast();
  srv = await startTestServer([
    createChromecastPlugin({
      mdns: { target: { address: "127.0.0.1", port: cast.mdnsPort }, interfaces: [], timeoutMs: 700 },
      eurekaPort: cast.eurekaPort,
      session: { requestTimeoutMs: 2000 },
      scanOnStart: false,
    }),
  ]);
});

after(async () => {
  await srv.cleanup();
  await cast.close();
});

const get = (url: string, token = srv.alice) => srv.app.inject({ method: "GET", url, headers: bearer(token) });
const post = (url: string, payload: unknown = {}, token = srv.alice) =>
  srv.app.inject({ method: "POST", url, headers: bearer(token), payload: payload as object });
type Dev = { id: string; name: string; kind: string; model?: string; manual?: boolean };
const firstId = async () => ((await get("/api/chromecast/devices")).json() as { devices: Dev[] }).devices[0]!.id;

test("CastMessage protobuf round trips, including non-ASCII text", () => {
  const m = { sourceId: "sender-0", destinationId: "receiver-0", namespace: "urn:x-cast:com.google.cast.receiver", payload: '{"type":"GET_STATUS","t":"café"}' };
  assert.deepEqual(decodeCastMessage(encodeCastMessage(m)), m);
});

test("the frame reader joins split TCP chunks and rejects oversized frames", () => {
  const a = frame({ sourceId: "a", destinationId: "b", namespace: "n", payload: "1" });
  const b = frame({ sourceId: "a", destinationId: "b", namespace: "n", payload: "2" });
  const all = Buffer.concat([a, b]);
  const reader = new FrameReader();
  assert.equal(reader.push(all.subarray(0, 7)).length, 0);
  assert.deepEqual(reader.push(all.subarray(7)).map((m) => m.payload), ["1", "2"]);
  const huge = Buffer.alloc(4);
  huge.writeUInt32BE(0x7fffffff);
  assert.throws(() => new FrameReader().push(huge));
});

test("DNS names follow compression pointers", () => {
  const buf = Buffer.concat([Buffer.from([0, 0]), Buffer.from([3, 102, 111, 111, 5, 108, 111, 99, 97, 108, 0]), Buffer.from([3, 98, 97, 114, 0xc0, 2])]);
  assert.equal(readName(buf, 13).name, "bar.foo.local");
});

test("an mDNS answer becomes a Chromecast entry", () => {
  const services = castServicesFrom([castAnnouncement({ id: "abc", fn: "Den", md: "Chromecast", port: 8009, address: "192.168.1.9" })]);
  assert.deepEqual(services, [{ id: "abc", name: "Den", model: "Chromecast", host: "192.168.1.9", port: 8009 }]);
  assert.deepEqual(castServicesFrom([Buffer.from("garbage")]), []);
});

test("mDNS discovery finds the Chromecast", async () => {
  const body = (await get("/api/chromecast/devices?refresh=1")).json() as { devices: Dev[] };
  assert.equal(body.devices.length, 1);
  assert.equal(body.devices[0]!.name, "Kitchen speaker");
  assert.equal(body.devices[0]!.kind, "chromecast");
  assert.equal(body.devices[0]!.model, "Chromecast Audio");
});

test("play launches the media receiver and loads a signed stream URL with metadata", async () => {
  const id = await firstId();
  const res = await post(`/api/chromecast/devices/${id}/play`, { trackId: `server:${srv.trackId}`, positionSec: 12, autoplay: true });
  assert.equal(res.statusCode, 200, res.body);
  const types = cast.received.map((r) => r.payload["type"]);
  assert.ok(types.includes("CONNECT"));
  assert.ok(types.includes("LAUNCH"));
  const load = cast.received.find((r) => r.payload["type"] === "LOAD")!;
  assert.equal(load.destinationId, "web-5");
  const media = load.payload["media"] as { contentId: string; contentType: string; metadata: { title: string } };
  assert.match(media.contentId, /\/api\/stream\/.+\?exp=\d+&sig=/);
  assert.match(media.contentType, /audio/);
  assert.equal(media.metadata.title, "song");
  assert.equal(load.payload["currentTime"], 12);
  const url = new URL(media.contentId);
  assert.equal((await srv.app.inject({ method: "GET", url: url.pathname + url.search })).statusCode, 200);
});

test("pause, resume, seek, volume and status go to the right namespaces", async () => {
  const id = await firstId();
  assert.equal((await post(`/api/chromecast/devices/${id}/pause`)).statusCode, 200);
  assert.equal(cast.state.playerState, "PAUSED");
  assert.equal((await get(`/api/chromecast/devices/${id}/status`)).json().state, "paused");
  assert.equal((await post(`/api/chromecast/devices/${id}/resume`)).statusCode, 200);
  assert.equal(cast.state.playerState, "PLAYING");
  assert.equal((await post(`/api/chromecast/devices/${id}/seek`, { positionSec: 77 })).statusCode, 200);
  assert.equal(cast.state.currentTime, 77);
  assert.equal((await post(`/api/chromecast/devices/${id}/volume`, { volume: 0.25 })).statusCode, 200);
  assert.equal(cast.state.volume, 0.25);
  const status = (await get(`/api/chromecast/devices/${id}/status`)).json();
  assert.deepEqual(status, { state: "playing", positionSec: 77, durationSec: 180, volume: 0.25, muted: false });
  const pauseMsg = cast.received.filter((r) => r.payload["type"] === "PAUSE").at(-1)!;
  assert.equal(pauseMsg.payload["mediaSessionId"], 1);
  assert.equal((await post(`/api/chromecast/devices/${id}/stop`)).statusCode, 200);
  assert.equal((await get(`/api/chromecast/devices/${id}/status`)).json().state, "stopped");
});

test("a device that refuses a track gives a clear error", async () => {
  const id = await firstId();
  // The fake refuses any URL containing "fail", so point the stream base there.
  const put = (streamBaseUrl: string | null) =>
    srv.app.inject({ method: "PUT", url: "/api/chromecast/config", headers: bearer(srv.admin), payload: { streamBaseUrl } });
  await put("http://fail.example:8787");
  const res = await post(`/api/chromecast/devices/${id}/play`, { trackId: `server:${srv.trackId}` });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, "device_error");
  assert.match(res.json().message, /could not load/);
  await put(null);
});

test("a manual address reads the name, and only an admin can add one", async () => {
  const addr = `127.0.0.1:${cast.castPort}`;
  assert.equal((await post("/api/chromecast/devices/manual", { address: addr })).statusCode, 403);
  const ok = await post("/api/chromecast/devices/manual", { address: addr }, srv.admin);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().name, "Kitchen speaker");
  assert.equal(ok.json().manual, true);
  const nothing = await post("/api/chromecast/devices/manual", { address: "127.0.0.1:1" }, srv.admin);
  assert.equal(nothing.statusCode, 422);
  assert.match(nothing.json().message, /No Chromecast answered/);
});

test("removing a manual Chromecast forgets it; the discovered one keeps working", async () => {
  const list = ((await get("/api/chromecast/devices")).json() as { devices: Dev[] }).devices;
  const manual = list.find((d) => d.manual)!;
  const del = await srv.app.inject({ method: "DELETE", url: `/api/chromecast/devices/manual/${manual.id}`, headers: bearer(srv.admin) });
  assert.equal(del.statusCode, 200);
  const id = list.find((d) => !d.manual)!.id;
  assert.equal((await get(`/api/chromecast/devices/${id}/status`)).statusCode, 200);
});
