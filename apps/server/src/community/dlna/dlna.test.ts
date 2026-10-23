import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { parseXml, findNode } from "../_devices/xml.js";
import { bearer, startTestServer, type TestServer } from "../_devices/testkit.js";
import { didlLite, formatTime, parseDescription, parseTime } from "./upnp.js";
import { parseSsdpResponse } from "./ssdp.js";
import { startFakeRenderer, type FakeRenderer } from "./fakeRenderer.js";
import { createDlnaPlugin } from "./plugin.js";

let generic: FakeRenderer;
let sonos: FakeRenderer;
let srv: TestServer;

before(async () => {
  generic = await startFakeRenderer({});
  // The plugin's discovery is pointed at the generic renderer's SSDP socket; the Sonos one is added by
  // address (the manual path).
  sonos = await startFakeRenderer({ sonos: true });
  srv = await startTestServer([
    createDlnaPlugin({ ssdp: { target: { address: "127.0.0.1", port: generic.ssdpPort }, interfaces: [], timeoutMs: 700 }, scanOnStart: false }),
  ]);
});

after(async () => {
  await srv.cleanup();
  await generic.close().catch(() => undefined);
  await sonos.close();
});

const get = (url: string, token = srv.alice) => srv.app.inject({ method: "GET", url, headers: bearer(token) });
const post = (url: string, payload: unknown = {}, token = srv.alice) =>
  srv.app.inject({ method: "POST", url, headers: bearer(token), payload: payload as object });
type Dev = { id: string; name: string; kind: string; manual?: boolean };
const deviceId = async (name: string) => ((await get("/api/dlna/devices")).json() as { devices: Dev[] }).devices.find((d) => d.name === name)!.id;

test("xml reader handles namespaces, entities and CDATA", () => {
  const root = parseXml('<?xml version="1.0"?><a:r xmlns:a="x"><a:t k="1">x &amp; y</a:t><c><![CDATA[<z>]]></c></a:r>');
  assert.equal(findNode(root, "t")?.text, "x & y");
  assert.equal(findNode(root, "t")?.attrs["k"], "1");
  assert.equal(findNode(root, "c")?.text, "<z>");
});

test("time helpers round trip", () => {
  assert.equal(formatTime(3725), "1:02:05");
  assert.equal(parseTime("0:01:23.500"), 83);
  assert.equal(parseTime("NOT_IMPLEMENTED"), undefined);
});

test("SSDP replies are parsed and junk is ignored", () => {
  const ok = parseSsdpResponse("HTTP/1.1 200 OK\r\nLOCATION: http://10.0.0.5:1400/xml/device_description.xml\r\nST: urn:x\r\nUSN: uuid:abc::urn:x\r\n\r\n");
  assert.equal(ok?.location, "http://10.0.0.5:1400/xml/device_description.xml");
  assert.equal(parseSsdpResponse("HTTP/1.1 200 OK\r\nLOCATION: file:///etc/passwd\r\n\r\n"), null);
  assert.equal(parseSsdpResponse("GET / HTTP/1.1\r\n\r\n"), null);
});

test("a description whose control URL points at another machine is ignored", () => {
  const xml = `<root><device><UDN>uuid:x</UDN><friendlyName>Evil</friendlyName><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>http://169.254.169.254/latest</controlURL></service></serviceList></device></root>`;
  assert.equal(parseDescription(xml, "http://192.168.1.9:80/d.xml"), null);
});

test("DIDL-Lite escapes metadata", () => {
  const didl = didlLite({ url: "http://h/s?a=1&b=2", title: "A <b> & C", startSec: 0, autoplay: true, durationSec: 61, mime: "audio/flac" });
  assert.match(didl, /A &lt;b&gt; &amp; C/);
  assert.match(didl, /audio\/flac/);
  assert.match(didl, /duration="0:01:01"/);
  assert.doesNotThrow(() => parseXml(didl));
});

test("endpoints need a signed-in user", async () => {
  assert.equal((await srv.app.inject({ method: "GET", url: "/api/dlna/devices" })).statusCode, 401);
});

test("SSDP discovery lists the renderer found on the network", async () => {
  const res = await get("/api/dlna/devices?refresh=1");
  assert.equal(res.statusCode, 200);
  const body = res.json() as { devices: Dev[] };
  assert.equal(body.devices.length, 1);
  assert.equal(body.devices[0]!.name, "Fake Speaker");
  assert.equal(body.devices[0]!.kind, "upnp");
  assert.notEqual(body.devices[0]!.manual, true);
});

test("a manual address adds a Sonos speaker, labelled as Sonos, and only an admin may add it", async () => {
  assert.equal((await post("/api/dlna/devices/manual", { address: sonos.location })).statusCode, 403);
  assert.equal((await post("/api/dlna/devices/manual", { address: "ftp://nope" }, srv.admin)).statusCode, 422);
  const ok = await post("/api/dlna/devices/manual", { address: sonos.location }, srv.admin);
  assert.equal(ok.statusCode, 200, ok.body);
  const dev = ok.json() as Dev;
  assert.equal(dev.kind, "sonos");
  assert.equal(dev.name, "Living Room");
  assert.equal(dev.manual, true);
  assert.equal(((await get("/api/dlna/devices")).json() as { devices: Dev[] }).devices.length, 2);
});

test("play hands the speaker a short-lived signed stream URL that the server honours", async () => {
  const id = await deviceId("Fake Speaker");
  const res = await post(`/api/dlna/devices/${id}/play`, { trackId: `server:${srv.trackId}`, positionSec: 0, autoplay: true });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(generic.calls.slice(0, 2).map((c) => c.action), ["SetAVTransportURI", "Play"]);
  const uri = new URL(generic.state.uri);
  assert.match(uri.pathname, /^\/api\/stream\//);
  const exp = Number(uri.searchParams.get("exp"));
  const ttl = exp - Math.floor(Date.now() / 1000);
  assert.ok(ttl > 0 && ttl <= 60 * 60, `ttl ${ttl}s should be short`);
  // The speaker fetches this path from the server.
  const stream = await srv.app.inject({ method: "GET", url: uri.pathname + uri.search });
  assert.equal(stream.statusCode, 200);
  assert.match(String(stream.headers["content-type"]), /audio/);
  assert.equal((await srv.app.inject({ method: "GET", url: `${uri.pathname}?exp=${exp}&sig=bad` })).statusCode, 403);
  assert.equal((await srv.app.inject({ method: "GET", url: `${uri.pathname}?exp=1&sig=${uri.searchParams.get("sig")}` })).statusCode, 403);
  assert.match(generic.state.meta, /<upnp:class>object\.item\.audioItem\.musicTrack<\/upnp:class>/);
});

test("transport controls reach the speaker and status reflects it", async () => {
  const id = await deviceId("Fake Speaker");
  assert.equal((await post(`/api/dlna/devices/${id}/pause`)).statusCode, 200);
  assert.equal(generic.state.transport, "PAUSED_PLAYBACK");
  assert.equal((await get(`/api/dlna/devices/${id}/status`)).json().state, "paused");
  assert.equal((await post(`/api/dlna/devices/${id}/resume`)).statusCode, 200);
  assert.equal((await get(`/api/dlna/devices/${id}/status`)).json().state, "playing");
  assert.equal((await post(`/api/dlna/devices/${id}/seek`, { positionSec: 83 })).statusCode, 200);
  assert.equal(generic.state.relTime, "0:01:23");
  const status = (await get(`/api/dlna/devices/${id}/status`)).json() as { positionSec: number; durationSec: number; volume: number };
  assert.equal(status.positionSec, 83);
  assert.equal(status.durationSec, 180);
  assert.equal(status.volume, 0.3);
  assert.equal((await post(`/api/dlna/devices/${id}/volume`, { volume: 0.55 })).statusCode, 200);
  assert.equal(generic.state.volume, 55);
  assert.equal((await post(`/api/dlna/devices/${id}/volume`, { volume: "loud" })).statusCode, 400);
  assert.equal((await post(`/api/dlna/devices/${id}/stop`)).statusCode, 200);
  assert.equal(generic.state.transport, "STOPPED");
});

test("starting at a position seeks once the speaker is playing; autoplay false leaves it paused", async () => {
  const id = await deviceId("Living Room");
  const res = await post(`/api/dlna/devices/${id}/play`, { trackId: `server:${srv.trackId}`, positionSec: 42, autoplay: false });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(sonos.state.relTime, "0:00:42");
  assert.equal(sonos.state.transport, "PAUSED_PLAYBACK");
});

test("a stream base URL override is used in the link", async () => {
  const put = (token: string, streamBaseUrl: string) =>
    srv.app.inject({ method: "PUT", url: "/api/dlna/config", headers: bearer(token), payload: { streamBaseUrl } });
  assert.equal((await put(srv.admin, "http://192.168.1.50:8787/ignored/path")).json().streamBaseUrl, "http://192.168.1.50:8787");
  const id = await deviceId("Fake Speaker");
  await post(`/api/dlna/devices/${id}/play`, { trackId: `server:${srv.trackId}` });
  assert.ok(generic.state.uri.startsWith("http://192.168.1.50:8787/api/stream/"), generic.state.uri);
  assert.equal((await put(srv.alice, "http://x")).statusCode, 403);
  assert.equal((await put(srv.admin, "javascript:alert(1)")).statusCode, 400);
});

test("tracks from other sources and unknown devices are refused clearly", async () => {
  const id = await deviceId("Fake Speaker");
  const spotify = await post(`/api/dlna/devices/${id}/play`, { trackId: "spotify:track:1" });
  assert.equal(spotify.statusCode, 422);
  assert.equal(spotify.json().error, "unsupported_track");
  assert.equal((await post("/api/dlna/devices/nope/play", { trackId: `server:${srv.trackId}` })).statusCode, 404);
  assert.equal((await post(`/api/dlna/devices/${id}/play`, { trackId: "server:missing" })).statusCode, 404);
});

test("a device error comes back as a short message", async () => {
  const id = await deviceId("Fake Speaker");
  await generic.close();
  const res = await post(`/api/dlna/devices/${id}/pause`);
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, "device_error");
  assert.ok(!/127\.0\.0\.1/.test(res.body), "no addresses leak to the client");
});

test("removing a manual device forgets it", async () => {
  const id = await deviceId("Living Room");
  const del = (token: string) => srv.app.inject({ method: "DELETE", url: `/api/dlna/devices/manual/${id}`, headers: bearer(token) });
  assert.equal((await del(srv.alice)).statusCode, 403);
  assert.equal((await del(srv.admin)).statusCode, 200);
  assert.equal((await del(srv.admin)).statusCode, 404);
});
