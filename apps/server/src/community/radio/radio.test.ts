import { test } from "node:test";
import assert from "node:assert/strict";

import { fake, harness, rawFake, type Fake, type Harness } from "../_sourcekit/testkit.js";
import { IcyStripper, metaInterval, parseStreamTitle } from "./icy.js";
import { firstPlaylistEntry, looksLikeHls, rewritePlaylist } from "./hls.js";
import { createRadioPlugin, type RadioOptions } from "./plugin.js";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";
const U4 = "44444444-4444-4444-8444-444444444444";

const raw = (uuid: string, name: string, url: string, extra: Record<string, unknown> = {}) => ({
  stationuuid: uuid,
  name,
  url,
  url_resolved: url,
  homepage: "https://example.org/",
  favicon: "",
  tags: "jazz,chill",
  country: "Norway",
  countrycode: "NO",
  language: "norwegian",
  votes: 10,
  codec: "MP3",
  bitrate: 128,
  hls: 0,
  clickcount: 5,
  ...extra,
});

/** Audio of `blocks` metaint-sized blocks, each followed by a metadata block carrying the given title (or none). */
function icyPayload(metaint: number, titles: (string | null)[]): { wire: Buffer; audio: Buffer } {
  const wire: Buffer[] = [];
  const audio: Buffer[] = [];
  titles.forEach((title, i) => {
    const block = Buffer.alloc(metaint, 0x41 + i);
    audio.push(block);
    wire.push(block);
    if (title === null) wire.push(Buffer.from([0]));
    else {
      const text = Buffer.from(`StreamTitle='${title}';StreamUrl='';`, "utf8");
      const len = Math.ceil(text.length / 16);
      wire.push(Buffer.from([len]), text, Buffer.alloc(len * 16 - text.length));
    }
  });
  return { wire: Buffer.concat(wire), audio: Buffer.concat(audio) };
}

async function build(stationsInit: (self: { port: number }) => Map<string, ReturnType<typeof raw>> | Promise<Map<string, ReturnType<typeof raw>>>, extra: (h: Harness) => Promise<Fake[]> = async () => [], pluginOpts: RadioOptions = {}) {
  const state = { directory: null as Fake | null, stations: new Map<string, ReturnType<typeof raw>>() };
  const bases: string[] = [];
  const h = await harness((policy) => createRadioPlugin({ policy, directoryBases: bases, streamIdleMs: 2000, headerTimeoutMs: 3000, ...pluginOpts }));
  const directory = await fake(h, (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    res.setHeader("Content-Type", "application/json");
    const byuuid = /^\/json\/stations\/byuuid\/(.+)$/.exec(url.pathname);
    if (byuuid) return void res.end(JSON.stringify([...state.stations.values()].filter((s) => s.stationuuid === byuuid[1])));
    if (url.pathname === "/json/stations/search") {
      const name = url.searchParams.get("name")?.toLowerCase();
      const tag = url.searchParams.get("tag");
      const list = [...state.stations.values()].filter((s) => (!name || s.name.toLowerCase().includes(name)) && (!tag || s.tags.split(",").includes(tag)));
      return void res.end(JSON.stringify(list));
    }
    if (/^\/json\/stations\/top(vote|click)\/\d+$/.test(url.pathname)) return void res.end(JSON.stringify([...state.stations.values()]));
    if (url.pathname === "/json/tags") return void res.end(JSON.stringify([{ name: "jazz", stationcount: 12 }, { name: "empty", stationcount: 0 }]));
    if (url.pathname === "/json/countries") return void res.end(JSON.stringify([{ name: "Norway", iso_3166_1: "NO", stationcount: 7 }]));
    if (url.pathname.startsWith("/json/url/")) return void res.end(JSON.stringify({ ok: true }));
    res.writeHead(404).end("{}");
  });
  bases.push(directory.url);
  const others = await extra(h);
  state.stations = await stationsInit({ port: directory.port });
  return {
    h,
    directory,
    state,
    others,
    stream: async (who: { authorization: string }, id: string) => {
      const r = await h.app.inject({ method: "GET", url: `/api/radio/stations/${id}/stream-url`, headers: who });
      assert.equal(r.statusCode, 200, r.body);
      return `/${(r.json() as { path: string }).path}`;
    },
    close: async () => {
      await h.close();
      await directory.close();
      for (const o of others) await o.close();
    },
  };
}

const get = (r: { h: Harness }, url: string, who: { authorization: string } | null) => r.h.app.inject({ method: "GET", url, headers: who ?? {} });

// ---- pure helpers ----------------------------------------------------------------

test("ICY: StreamTitle parsing keeps apostrophes, strips control characters, handles latin-1 and blanks", () => {
  assert.equal(parseStreamTitle(Buffer.from("StreamTitle='Artist - Song';StreamUrl='x';")), "Artist - Song");
  assert.equal(parseStreamTitle(Buffer.from("StreamTitle='Don't Stop Me Now';")), "Don't Stop Me Now");
  assert.equal(parseStreamTitle(Buffer.from("StreamTitle='Rock 'n' Roll';StreamUrl='';")), "Rock 'n' Roll");
  assert.equal(parseStreamTitle(Buffer.from("StreamTitle='';")), null);
  assert.equal(parseStreamTitle(Buffer.from("StreamTitle='A\u0001\nB';")), "A B");
  assert.equal(parseStreamTitle(Buffer.from("StreamTitle='Caf\xe9';", "latin1")), "Caf\u00e9");
  assert.equal(parseStreamTitle(Buffer.from("garbage")), null);
  assert.equal(parseStreamTitle(Buffer.from(`StreamTitle='${"x".repeat(500)}';`))!.length, 200);
  assert.equal(metaInterval("16000"), 16000);
  assert.equal(metaInterval("0"), null);
  assert.equal(metaInterval("99999999"), null);
  assert.equal(metaInterval(undefined), null);
});

test("ICY: the stripper removes metadata whatever the chunk sizes and reports each new title once", () => {
  const { wire, audio } = icyPayload(16, ["One", null, "One", "Two", null, "Three"]);
  for (const size of [1, 3, 7, 16, 17, 33, wire.length]) {
    const titles: (string | null)[] = [];
    const out: Buffer[] = [];
    const s = new IcyStripper(16, (t) => titles.push(t));
    s.on("data", (c: Buffer) => out.push(c));
    for (let i = 0; i < wire.length; i += size) s.write(wire.subarray(i, i + size));
    s.end();
    assert.equal(Buffer.concat(out).equals(audio), true, `chunk size ${size}`);
    // "One" then (empty block keeps the title, only a *different* one is reported) ... "Two", "Three".
    assert.deepEqual(titles.filter((t) => t !== null), ["One", "Two", "Three"], `chunk size ${size}`);
  }
});

test("HLS: playlists are recognised and every URI is rewritten, other schemes dropped", () => {
  const text = [
    "#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:6", '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"', "#EXTINF:6.0,", "seg1.aac", "#EXTINF:6.0,", "https://cdn.example/seg2.aac", "file:///etc/passwd", "data:text/plain,hi",
  ].join("\n");
  assert.equal(looksLikeHls(text), true);
  assert.equal(looksLikeHls("<html>nope</html>"), false);
  const out = rewritePlaylist(text, new URL("http://radio.example/live/index.m3u8"), (u) => `P(${u})`);
  assert.match(out, /URI="P\(http:\/\/radio\.example\/live\/key\.bin\)"/);
  assert.match(out, /^P\(http:\/\/radio\.example\/live\/seg1\.aac\)$/m);
  assert.match(out, /^P\(https:\/\/cdn\.example\/seg2\.aac\)$/m);
  assert.ok(!out.includes("file:") && !out.includes("data:"));
  assert.equal(firstPlaylistEntry("[playlist]\nNumberOfEntries=1\nFile1=http://s.example:8000/live\nTitle1=x", new URL("http://a/"))?.toString(), "http://s.example:8000/live");
  assert.equal(firstPlaylistEntry("#EXTM3U\n#EXTINF:-1,x\nhttp://s.example/a.mp3\n", new URL("http://a/"))?.toString(), "http://s.example/a.mp3");
  assert.equal(firstPlaylistEntry("file:///etc/passwd\njavascript:alert(1)", new URL("http://a/")), null);
});

// ---- directory ---------------------------------------------------------------------

test("directory: search, top, trending and facets map stations; stream addresses never reach the client", async () => {
  const r = await build(() => new Map([[U1, raw(U1, "Jazz FM", "http://stream.example:8000/jazz", { favicon: "http://img.example/logo.png" })], [U2, raw(U2, "Rock Radio", "http://stream.example/rock", { tags: "rock" })]]));
  assert.equal((await get(r, "/api/radio/stations", null)).statusCode, 401);
  const res = await get(r, "/api/radio/stations?name=jazz&limit=10", r.h.alice);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { items: { id: string; name: string; tags: string[]; favicon?: string; hls: boolean }[] };
  assert.deepEqual(body.items.map((s) => s.name), ["Jazz FM"]);
  assert.deepEqual(body.items[0].tags, ["jazz", "chill"]);
  assert.match(body.items[0].favicon!, /^api\/radio\/image\?t=[\w-]+&u=\d+&exp=\d+&sig=[\w-]+$/);
  assert.ok(!res.body.includes("stream.example"), "the real stream address is not exposed");
  assert.ok(!res.body.includes("img.example"));
  const q = r.directory.seen.find((s) => s.url.startsWith("/json/stations/search"))!;
  const params = new URL(q.url, "http://x").searchParams;
  assert.equal(params.get("hidebroken"), "true");
  assert.equal(params.get("limit"), "10");
  assert.equal(r.directory.seen[0].headers["user-agent"]?.startsWith("Cadence-Server/"), true);

  assert.equal(((await get(r, "/api/radio/stations?tag=rock&country=no", r.h.alice)).json() as { items: unknown[] }).items.length, 1);
  assert.ok(new URL(r.directory.seen.at(-1)!.url, "http://x").searchParams.get("countrycode") === "NO");
  assert.equal(((await get(r, "/api/radio/top", r.h.alice)).json() as { items: unknown[] }).items.length, 2);
  assert.equal(((await get(r, "/api/radio/trending?limit=5", r.h.alice)).json() as { items: unknown[] }).items.length, 2);
  assert.deepEqual((await get(r, "/api/radio/facets/tags", r.h.alice)).json(), { items: [{ name: "jazz", count: 12 }] });
  assert.deepEqual((await get(r, "/api/radio/facets/countries", r.h.alice)).json(), { items: [{ name: "Norway", count: 7, code: "NO" }] });
  assert.equal((await get(r, "/api/radio/facets/nonsense", r.h.alice)).statusCode, 404);
  assert.equal((await get(r, "/api/radio/stations/not-a-uuid", r.h.alice)).statusCode, 400);
  assert.equal((await get(r, `/api/radio/stations/${U3}`, r.h.alice)).statusCode, 404);
  assert.equal((await get(r, `/api/radio/stations/${U1}`, r.h.alice)).statusCode, 200);
  await r.close();
});

test("directory: falls back to the next server, and reports a fixed message when all are down", async () => {
  const state = { stations: [raw(U1, "Jazz FM", "http://s.example/j")] };
  const bases: string[] = ["http://127.0.0.1:1"];
  const h = await harness((policy) => createRadioPlugin({ policy: { ...policy, allow: (host) => host === "127.0.0.1" }, directoryBases: bases, headerTimeoutMs: 1000 }));
  const up = await fake(h, (_req, res) => res.setHeader("Content-Type", "application/json").end(JSON.stringify(state.stations)));
  bases.push(up.url);
  const ok = await h.app.inject({ method: "GET", url: "/api/radio/stations?name=a", headers: h.alice });
  assert.equal(ok.statusCode, 200);
  await up.close();
  const down = await h.app.inject({ method: "GET", url: "/api/radio/stations?name=zzz", headers: h.alice });
  assert.equal(down.statusCode, 502);
  assert.equal(down.json().error, "upstream_failed");
  assert.ok(!down.body.includes("127.0.0.1"));
  await h.close();
});

test("directory: ignores stations with unusable data (no id, no http address, hostile scheme)", async () => {
  const r = await build(() => new Map([
    [U1, raw(U1, "Good", "https://ok.example/s")],
    [U2, raw(U2, "Bad scheme", "file:///etc/passwd", { url: "javascript:alert(1)" })],
    ["x", raw("not-a-uuid", "Bad id", "http://a.example/")],
    [U3, raw(U3, "", "http://a.example/")],
  ]));
  const items = ((await get(r, "/api/radio/stations?limit=50", r.h.alice)).json() as { items: { name: string }[] }).items;
  assert.deepEqual(items.map((i) => i.name), ["Good"]);
  await r.close();
});

// ---- streaming and ICY metadata ------------------------------------------------------

test("stream: plain ICY (Shoutcast) stream is proxied without metadata and the title is surfaced", async () => {
  const { wire, audio } = icyPayload(32, [null, "First Artist - First Song", null, "Second Artist - Don't Stop"]);
  const station = await rawFake(null, (s) => {
    s.write(Buffer.from("ICY 200 OK\r\nicy-name: Test FM\r\nicy-metaint: 32\r\ncontent-type: audio/mpeg\r\n\r\n"));
    s.end(wire);
  });
  const r = await build(() => new Map([[U1, raw(U1, "Test FM", station.url + "/live")]]), async (h) => {
    h.fakePorts.add(station.port);
    return [station];
  });
  const path = await r.stream(r.h.alice, U1);
  const res = await get(r, path, null);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers["content-type"], "audio/mpeg");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.rawPayload.equals(audio), true, "metadata removed from the audio");
  assert.equal(station.seen[0].headers["icy-metadata"], "1", "asked the station for metadata");
  const np = (await get(r, `/api/radio/stations/${U1}/now-playing`, r.h.alice)).json() as { title: string | null; live: boolean };
  assert.equal(np.title, "Second Artist - Don't Stop");
  await r.close();
});

test("stream: standard HTTP (Icecast) stream with headers, and a station without metadata", async () => {
  const { wire, audio } = icyPayload(64, ["Live Now"]);
  const icecast = await fake(null, (_req, res) => {
    res.writeHead(200, { "Content-Type": "audio/aacp", "icy-metaint": "64", "icy-name": "Ice" });
    res.end(wire);
  });
  const plain = await fake(null, (_req, res) => {
    res.writeHead(200, { "Content-Type": "audio/ogg" });
    res.end(audio);
  });
  const r = await build(() => new Map([[U1, raw(U1, "Ice", icecast.url + "/a")], [U2, raw(U2, "Plain", plain.url + "/b")]]), async (h) => {
    h.fakePorts.add(icecast.port);
    h.fakePorts.add(plain.port);
    return [icecast, plain];
  });
  const a = await get(r, await r.stream(r.h.alice, U1), null);
  assert.equal(a.statusCode, 200);
  assert.equal(a.headers["content-type"], "audio/aacp");
  assert.equal(a.rawPayload.equals(audio), true);
  assert.equal(((await get(r, `/api/radio/stations/${U1}/now-playing`, r.h.alice)).json() as { title: string }).title, "Live Now");
  const b = await get(r, await r.stream(r.h.alice, U2), null);
  assert.equal(b.statusCode, 200);
  assert.equal(b.headers["content-type"], "audio/ogg");
  assert.equal(b.rawPayload.equals(audio), true);
  assert.equal(((await get(r, `/api/radio/stations/${U2}/now-playing`, r.h.alice)).json() as { title: unknown }).title, null);
  await r.close();
});

test("stream: signature is required, bound to the station and the expiry, and non-audio is refused", async () => {
  const page = await fake(null, (_req, res) => res.writeHead(200, { "Content-Type": "text/html" }).end("<script>alert(1)</script>"));
  const audioStation = await fake(null, (_req, res) => res.writeHead(200, { "Content-Type": "audio/mpeg" }).end("abc"));
  const r = await build(() => new Map([[U1, raw(U1, "Page", page.url + "/")], [U2, raw(U2, "Audio", audioStation.url + "/")]]), async (h) => {
    h.fakePorts.add(page.port);
    h.fakePorts.add(audioStation.port);
    return [page, audioStation];
  });
  const p1 = await r.stream(r.h.alice, U1);
  const p2 = await r.stream(r.h.alice, U2);
  // html is not relayed
  const html = await get(r, p1, null);
  assert.equal(html.statusCode, 502);
  assert.ok(!html.body.includes("script"));
  // no signature, tampered, swapped between stations
  assert.equal((await get(r, `/api/radio/stream/${U2}`, null)).statusCode, 403);
  assert.equal((await get(r, p2.replace(/sig=./, "sig=X"), null)).statusCode, 403);
  const swapped = p1.replace(U1, U2);
  assert.equal((await get(r, swapped, null)).statusCode, 403);
  assert.equal((await get(r, p2.replace(/exp=\d+/, "exp=1"), null)).statusCode, 403);
  assert.equal((await get(r, p2, null)).statusCode, 200);
  // a bearer token alone isn't a stream URL
  assert.equal((await get(r, `/api/radio/stream/${U2}`, r.h.alice)).statusCode, 403);
  await r.close();
});

test("stream: .pls and .m3u playlists are followed to the real stream", async () => {
  const stream = await fake(null, (_req, res) => res.writeHead(200, { "Content-Type": "audio/mpeg" }).end("AUDIO"));
  const lists = await fake(null, (req, res) => {
    if (req.url === "/a.pls") res.writeHead(200, { "Content-Type": "audio/x-scpls" }).end(`[playlist]\nNumberOfEntries=1\nFile1=${stream.url}/live\n`);
    else if (req.url === "/b.m3u") res.writeHead(200, { "Content-Type": "audio/x-mpegurl" }).end(`#EXTM3U\n${stream.url}/live\n`);
    else if (req.url === "/loop.pls") res.writeHead(200, { "Content-Type": "audio/x-scpls" }).end("File1=http://" + req.headers.host + "/loop.pls\n");
    else res.writeHead(404).end();
  });
  const r = await build(() => new Map([[U1, raw(U1, "Pls", lists.url + "/a.pls")], [U2, raw(U2, "M3u", lists.url + "/b.m3u")], [U3, raw(U3, "Loop", lists.url + "/loop.pls")]]), async (h) => {
    h.fakePorts.add(stream.port);
    h.fakePorts.add(lists.port);
    return [stream, lists];
  });
  assert.equal((await get(r, await r.stream(r.h.alice, U1), null)).payload, "AUDIO");
  assert.equal((await get(r, await r.stream(r.h.alice, U2), null)).payload, "AUDIO");
  assert.equal((await get(r, await r.stream(r.h.alice, U3), null)).statusCode, 502, "a playlist that points to itself ends");
  await r.close();
});

test("stream: HLS stations come back as a rewritten playlist whose segments are proxied with signed URLs", async () => {
  const cdn = await fake(null, (req, res) => {
    if (req.url?.startsWith("/live/index.m3u8"))
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" }).end("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:6.0,\nseg1.aac\n#EXTINF:6.0,\nseg2.aac\n");
    else if (req.url?.startsWith("/live/seg")) res.writeHead(200, { "Content-Type": "audio/aac" }).end("SEG:" + req.url);
    else res.writeHead(404).end();
  });
  const r = await build(() => new Map([[U1, raw(U1, "HLS", cdn.url + "/live/index.m3u8", { hls: 1 })]]), async (h) => {
    h.fakePorts.add(cdn.port);
    return [cdn];
  });
  const su = await get(r, `/api/radio/stations/${U1}/stream-url`, r.h.alice);
  assert.equal((su.json() as { hls: boolean }).hls, true);
  const playlist = await get(r, `/${(su.json() as { path: string }).path}`, null);
  assert.equal(playlist.statusCode, 200, playlist.body);
  assert.equal(playlist.headers["content-type"], "application/vnd.apple.mpegurl");
  assert.ok(!playlist.body.includes(cdn.url), "origin address hidden");
  const lines = playlist.body.split("\n").filter((l) => l.startsWith("/api/radio/hls"));
  assert.equal(lines.length, 2);
  const seg = await get(r, lines[0], null);
  assert.equal(seg.statusCode, 200);
  assert.equal(seg.payload, "SEG:/live/seg1.aac");
  // tampering with the target invalidates the signature
  const evil = lines[0].replace(/t=[\w-]+/, `t=${Buffer.from("http://169.254.169.254/").toString("base64url")}`);
  assert.equal((await get(r, evil, null)).statusCode, 403);
  assert.equal((await get(r, "/api/radio/hls?t=abc", null)).statusCode, 403);
  await r.close();
});

// ---- SSRF ------------------------------------------------------------------------------

test("SSRF: stations (and their redirects, playlists and logos) pointing at private addresses are never fetched", async () => {
  const secret = await fake(null, (_req, res) => res.writeHead(200, { "Content-Type": "audio/mpeg" }).end("INTERNAL-SECRET"));
  const bouncer = await fake(null, (req, res) => {
    if (req.url === "/meta") res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" }).end();
    else if (req.url === "/inward") res.writeHead(302, { Location: secret.url + "/" }).end();
    else if (req.url === "/hls.m3u8") res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" }).end(`#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:1,\n${secret.url}/seg.aac\n`);
    else if (req.url === "/pls") res.writeHead(200, { "Content-Type": "audio/x-scpls" }).end(`File1=${secret.url}/\n`);
    else if (req.url === "/logo") res.writeHead(302, { Location: secret.url + "/" }).end();
    else res.writeHead(404).end();
  });
  const r = await build(
    () => new Map([
      [U1, raw(U1, "Direct", "http://127.0.0.1:9/")],
      [U2, raw(U2, "Meta", bouncer.url + "/meta")],
      [U3, raw(U3, "Inward", bouncer.url + "/inward")],
      [U4, raw(U4, "Hls", bouncer.url + "/hls.m3u8", { hls: 1, favicon: bouncer.url + "/logo" })],
      ["55555555-5555-4555-8555-555555555555", raw("55555555-5555-4555-8555-555555555555", "Pls", bouncer.url + "/pls")],
    ]),
    async (h) => {
      h.fakePorts.add(bouncer.port);
      // The "secret" service is deliberately NOT allowed.
      return [bouncer, secret];
    },
  );
  for (const id of [U1, U2, U3, "55555555-5555-4555-8555-555555555555"]) {
    const res = await get(r, await r.stream(r.h.alice, id), null);
    assert.equal(res.statusCode, 502, id);
    assert.equal(res.json().error, "address_not_allowed", id);
    assert.ok(!res.body.includes("INTERNAL-SECRET"));
  }
  // an HLS playlist is rewritten, but its private segment URL is refused when fetched
  const pl = await get(r, await r.stream(r.h.alice, U4), null);
  assert.equal(pl.statusCode, 200);
  const segPath = pl.body.split("\n").find((l) => l.startsWith("/api/radio/hls"))!;
  const seg = await get(r, segPath, null);
  assert.equal(seg.statusCode, 502);
  assert.equal(seg.json().error, "address_not_allowed");
  // the logo redirects inward: the proxy gives up quietly
  const station = (await get(r, `/api/radio/stations/${U4}`, r.h.alice)).json() as { favicon: string };
  assert.equal((await get(r, `/${station.favicon}`, null)).statusCode, 404);
  assert.equal(secret.seen.length, 0, "the internal service was never contacted");
  await r.close();
});

// ---- favourites -------------------------------------------------------------------------

test("favourites: per person, survive the directory going away, and are bounded", async () => {
  const stream = await fake(null, (_req, res) => res.writeHead(200, { "Content-Type": "audio/mpeg" }).end("ok"));
  const r = await build(() => new Map([[U1, raw(U1, "Jazz FM", stream.url + "/j")], [U2, raw(U2, "Rock", stream.url + "/r")]]), async (h) => {
    h.fakePorts.add(stream.port);
    return [stream];
  });
  const put = (who: { authorization: string }, id: string) => r.h.app.inject({ method: "PUT", url: `/api/radio/favourites/${id}`, headers: who });
  assert.equal((await put(r.h.alice, U1)).statusCode, 200);
  assert.equal((await put(r.h.alice, U2)).statusCode, 200);
  assert.equal((await put(r.h.alice, U1)).statusCode, 200, "idempotent");
  assert.equal((await put(r.h.alice, U3)).statusCode, 404);
  assert.equal((await put(r.h.alice, "nope")).statusCode, 400);
  assert.equal((await r.h.app.inject({ method: "PUT", url: `/api/radio/favourites/${U1}` })).statusCode, 401);

  const names = async (who: { authorization: string }) => ((await get(r, "/api/radio/favourites", who)).json() as { items: { name: string }[] }).items.map((i) => i.name);
  assert.deepEqual((await names(r.h.alice)).sort(), ["Jazz FM", "Rock"]);
  assert.deepEqual(await names(r.h.bob), [], "bob sees none of alice's");
  assert.equal((await put(r.h.bob, U2)).statusCode, 200);
  assert.deepEqual(await names(r.h.bob), ["Rock"]);

  // removing is per person too
  assert.equal((await r.h.app.inject({ method: "DELETE", url: `/api/radio/favourites/${U2}`, headers: r.h.alice })).statusCode, 204);
  assert.deepEqual(await names(r.h.alice), ["Jazz FM"]);
  assert.deepEqual(await names(r.h.bob), ["Rock"]);
  await r.close();
});

test("favourites: a favourite still plays when the directory is unreachable, but only for its owner", async () => {
  const stream = await fake(null, (_req, res) => res.writeHead(200, { "Content-Type": "audio/mpeg" }).end("still-here"));
  const r = await build(() => new Map([[U1, raw(U1, "Jazz FM", stream.url + "/j")]]), async (h) => {
    h.fakePorts.add(stream.port);
    return [stream];
  }, { stationCacheMs: 1, directoryCacheMs: 1 });
  assert.equal((await r.h.app.inject({ method: "PUT", url: `/api/radio/favourites/${U1}`, headers: r.h.alice })).statusCode, 200);
  await r.directory.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const mine = await r.h.app.inject({ method: "GET", url: `/api/radio/stations/${U1}/stream-url`, headers: r.h.alice });
  assert.equal(mine.statusCode, 200);
  assert.equal((await get(r, `/${(mine.json() as { path: string }).path}`, null)).payload, "still-here");
  const theirs = await r.h.app.inject({ method: "GET", url: `/api/radio/stations/${U1}/stream-url`, headers: r.h.bob });
  assert.equal(theirs.statusCode, 502, "no snapshot for bob and no directory");
  await r.h.close();
  await stream.close();
});

test("favourites: capped per person", async () => {
  const r = await build(() => new Map(), async () => []);
  const insert = r.h.db.prepare("INSERT INTO radio_favourites (user_id, station_id, added_at, data) VALUES (?, ?, ?, ?)");
  const aliceId = (r.h.db.prepare("SELECT id FROM users WHERE username = 'alice'").get() as { id: number }).id;
  for (let i = 0; i < 500; i++) insert.run(aliceId, `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, i, "{}");
  const full = await r.h.app.inject({ method: "PUT", url: `/api/radio/favourites/${U1}`, headers: r.h.alice });
  assert.equal(full.statusCode, 409);
  await r.close();
});
