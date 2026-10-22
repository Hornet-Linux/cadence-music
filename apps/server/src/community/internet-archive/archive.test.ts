import { test } from "node:test";
import assert from "node:assert/strict";
import type { Response as LightMyRequestResponse } from "light-my-request";
import { fake, harness, type Auth, type Fake, type Harness } from "../_sourcekit/testkit.js";
import { isArchiveHost, kindOfFormat, licenceOf, pickTracks, textQuery, validIdentifier } from "./archive.js";
import { createArchivePlugin } from "./plugin.js";

const AUDIO = Buffer.from("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ");
const JPG = Buffer.from("ffd8ffe000104a464946", "hex");

const SHOW = {
  metadata: {
    identifier: "gd77-05-08",
    title: "Grateful Dead Live at Barton Hall on 1977-05-08",
    creator: "Grateful Dead",
    date: "1977-05-08",
    venue: "Barton Hall",
    coverage: "Ithaca, NY",
    taper: "Betty Cantor",
    source: "Soundboard > Reel > FLAC",
    licenseurl: "http://creativecommons.org/licenses/by-nc-sa/3.0/",
    description: "<p>A famous <b>show</b>.</p>",
    collection: ["etree", "GratefulDead"],
  },
  files: [
    { name: "gd77-05-08d1t02.flac", format: "Flac", track: "02", title: "Promised Land", length: "3:30", size: "30000000", source: "original" },
    { name: "gd77-05-08d1t01.flac", format: "Flac", track: "01", title: "New Minglewood Blues", length: "05:10.5", size: "40000000", source: "original" },
    { name: "gd77-05-08d1t01.mp3", format: "VBR MP3", track: "01", title: "New Minglewood Blues", length: "310.5", size: "5000000", source: "derivative", original: "gd77-05-08d1t01.flac" },
    { name: "gd77-05-08d1t01_64kb.mp3", format: "64Kbps MP3", track: "01", title: "New Minglewood Blues", length: "310.5", size: "2000000", source: "derivative", original: "gd77-05-08d1t01.flac" },
    { name: "gd77-05-08d1t02.mp3", format: "VBR MP3", track: "02", title: "Promised Land", length: "3:30", size: "4000000", source: "derivative", original: "gd77-05-08d1t02.flac" },
    { name: "gd77-05-08d1t01.ogg", format: "Ogg Vorbis", track: "01", title: "New Minglewood Blues", length: "310", size: "3000000" },
    { name: "gd77-05-08.jpg", format: "JPEG" },
    { name: "gd77-05-08_files.xml", format: "Metadata" },
    { name: "sub/dir/bonus.mp3", format: "VBR MP3", title: "Bonus", length: "10" },
  ],
};

interface Rig {
  h: Harness;
  site: Fake;
  other: Fake;
  call: (url: string, who: Auth | null, headers?: Record<string, string>) => Promise<LightMyRequestResponse>;
  close: () => Promise<void>;
}

async function rig(): Promise<Rig> {
  // "other" stands for somewhere that is not archive.org (an internal service a redirect might point at).
  const other = await fake(null, (_req, res) => res.writeHead(200, { "Content-Type": "audio/mpeg" }).end("INTERNAL-SECRET"));
  const site = await fake(null, (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (body: unknown, status = 200) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/advancedsearch.php") {
      return json({ responseHeader: { status: 0 }, response: { numFound: 2, start: 0, docs: [{ identifier: "gd77-05-08", title: "Barton Hall", creator: ["Grateful Dead"], date: "1977-05-08T00:00:00Z", year: "1977", downloads: 9000, licenseurl: "https://creativecommons.org/licenses/by-nc-sa/3.0/", mediatype: "etree" }, { identifier: "bad id!", title: "evil" }] } });
    }
    const meta = /^\/metadata\/([\w.-]+)$/.exec(url.pathname);
    if (meta) {
      if (meta[1] === "gd77-05-08") return json(SHOW);
      if (meta[1] === "lending") return json({ metadata: { identifier: "lending", title: "Borrow me", "access-restricted-item": "true" }, files: [{ name: "a.mp3", format: "VBR MP3" }] });
      if (meta[1] === "silent") return json({ metadata: { identifier: "silent", title: "Only video" }, files: [{ name: "a.mp4", format: "MPEG4" }] });
      return json({});
    }
    const dl = /^\/download\/([\w.-]+)\/(.+)$/.exec(url.pathname);
    if (dl) {
      if (dl[2] === "gd77-05-08d1t01.mp3") return void res.writeHead(302, { Location: "/dl-real/track1.mp3" }).end();
      if (dl[2] === "gd77-05-08d1t02.mp3") return void res.writeHead(302, { Location: `${other.url}/x.mp3` }).end();
      if (dl[2] === "sub/dir/bonus.mp3") return void res.writeHead(200, { "Content-Type": "audio/mpeg" }).end("bonus");
      return void res.writeHead(404).end();
    }
    if (url.pathname === "/dl-real/track1.mp3") {
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)!;
        const start = Number(m[1] || 0);
        const end = Math.min(Number(m[2] || AUDIO.length - 1), AUDIO.length - 1);
        return void res.writeHead(206, { "Content-Type": "audio/mpeg", "Content-Range": `bytes ${start}-${end}/${AUDIO.length}`, "Content-Length": String(end - start + 1) }).end(AUDIO.subarray(start, end + 1));
      }
      return void res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": String(AUDIO.length), "Accept-Ranges": "bytes" }).end(AUDIO);
    }
    if (url.pathname === "/services/img/gd77-05-08") return void res.writeHead(200, { "Content-Type": "image/jpeg" }).end(JPG);
    res.writeHead(404).end();
  });
  const h = await harness((policy) => createArchivePlugin({ policy, baseUrl: site.url, streamIdleMs: 2000, headerTimeoutMs: 3000 }));
  h.fakePorts.add(site.port);
  return {
    h,
    site,
    other,
    call: (url, who, headers) => h.app.inject({ method: "GET", url, headers: { ...(who ?? {}), ...(headers ?? {}) } }),
    close: async () => {
      await h.close();
      await site.close();
      await other.close();
    },
  };
}

// ---- pure helpers -----------------------------------------------------------------------

test("query building: search syntax is neutralised and only title/creator are searched", () => {
  assert.equal(textQuery("Grateful Dead"), "(title:(Grateful Dead) OR creator:(Grateful Dead))");
  assert.equal(textQuery("  "), null);
  assert.equal(textQuery(undefined), null);
  assert.equal(textQuery('"x" OR collection:(secret) AND -foo*'), "(title:(x collection secret foo) OR creator:(x collection secret foo))");
  assert.equal(textQuery("a\\b^c~d[e]{f}g"), "(title:(a b c d e f g) OR creator:(a b c d e f g))");
  assert.ok(!textQuery("x ) OR mediatype:(web")!.includes("mediatype:"));
  assert.equal(/title:(([^)]*))/.exec(textQuery("one two three four five six seven eight nine ten")!)![1].split(" ").length, 8, "capped at eight words");
  assert.equal(textQuery("O'Brien")!.includes("'"), false);
});

test("identifiers, hosts, formats, licences", () => {
  for (const ok of ["gd77-05-08", "a", "Item_1.v2"]) assert.equal(validIdentifier(ok), true, ok);
  for (const bad of ["", "../x", "a/b", "a b", "-x", ".x", "a?b", "x".repeat(200), 5, null]) assert.equal(validIdentifier(bad), false, String(bad));
  assert.equal(isArchiveHost("archive.org"), true);
  assert.equal(isArchiveHost("ia800102.us.archive.org"), true);
  assert.equal(isArchiveHost("archive.org.evil.com"), false);
  assert.equal(isArchiveHost("evilarchive.org"), false);
  assert.equal(kindOfFormat("VBR MP3"), "mp3");
  assert.equal(kindOfFormat("128Kbps MP3"), "mp3");
  assert.equal(kindOfFormat("Ogg Vorbis"), "ogg");
  assert.equal(kindOfFormat("24bit Flac"), "flac");
  assert.equal(kindOfFormat("JPEG"), null);
  assert.deepEqual(licenceOf("http://creativecommons.org/licenses/by-nc-sa/3.0/"), { name: "CC BY-NC-SA 3.0", url: "http://creativecommons.org/licenses/by-nc-sa/3.0/" });
  assert.equal(licenceOf("https://creativecommons.org/publicdomain/zero/1.0/")?.name, "CC0 (public domain dedication)");
  assert.equal(licenceOf("javascript:alert(1)"), null);
  assert.equal(licenceOf(undefined), null);
});

test("track picking: best encode per recording, in track order, falling back across formats", () => {
  const mp3 = pickTracks(SHOW.files, "mp3")!;
  assert.equal(mp3.kind, "mp3");
  assert.deepEqual(mp3.tracks.map((t) => [t.track, t.title, t.file]), [
    [1, "New Minglewood Blues", "gd77-05-08d1t01.mp3"],
    [2, "Promised Land", "gd77-05-08d1t02.mp3"],
    [null, "Bonus", "sub/dir/bonus.mp3"],
  ]);
  assert.deepEqual(mp3.tracks.map((t) => t.durationSec), [311, 210, 10]);
  assert.equal(pickTracks(SHOW.files, "ogg")!.kind, "ogg");
  assert.equal(pickTracks(SHOW.files, "flac")!.tracks.length, 2);
  assert.equal(pickTracks([{ name: "a.ogg", format: "Ogg Vorbis" }], "mp3")!.kind, "ogg", "falls back");
  assert.equal(pickTracks([{ name: "a.jpg", format: "JPEG" }]), null);
});

// ---- routes -------------------------------------------------------------------------------------

test("search: audio library and the Live Music Archive build safe queries; results drop bad identifiers", async () => {
  const r = await rig();
  assert.equal((await r.call("/api/archive/search?q=dead", null)).statusCode, 401);
  const res = await r.call("/api/archive/search?q=grateful%20dead&kind=etree&collection=GratefulDead&year=1977&sort=date", r.h.alice);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { items: { id: string; title: string; creator: string; date: string; licence: string; kind: string; cover: string }[]; total: number; hasMore: boolean };
  assert.deepEqual(body.items.map((i) => i.id), ["gd77-05-08"], "the entry with a bad identifier is dropped");
  assert.equal(body.items[0].creator, "Grateful Dead");
  assert.equal(body.items[0].date, "1977-05-08");
  assert.equal(body.items[0].licence, "CC BY-NC-SA 3.0");
  assert.equal(body.items[0].kind, "etree");
  assert.match(body.items[0].cover, /^api\/archive\/image\/gd77-05-08\?u=\d+&exp=\d+&sig=/);
  const q = new URL(r.site.seen[0].url, "http://x").searchParams;
  assert.equal(q.get("q"), "collection:(etree) AND mediatype:(etree) AND -access-restricted-item:true AND collection:(GratefulDead) AND year:(1977) AND (title:(grateful dead) OR creator:(grateful dead))");
  assert.deepEqual(q.getAll("sort[]"), ["date desc"]);
  assert.equal(q.get("output"), "json");
  assert.equal(r.site.seen[0].headers["user-agent"]?.startsWith("Cadence-Server/"), true);

  // injection attempts end up as plain words; a hostile collection or year is ignored
  await r.call(`/api/archive/search?q=${encodeURIComponent("x) OR mediatype:(web")}&collection=${encodeURIComponent("a) OR (b")}&year=19x7`, r.h.alice);
  const q2 = new URL(r.site.seen.at(-1)!.url, "http://x").searchParams.get("q")!;
  assert.equal(q2, "mediatype:(audio) AND -access-restricted-item:true AND (title:(x mediatype web) OR creator:(x mediatype web))");
  assert.ok(!q2.includes("collection:(a"));
  // the default front page is popular audio
  await r.call("/api/archive/search", r.h.alice);
  assert.match(new URL(r.site.seen.at(-1)!.url, "http://x").searchParams.get("q")!, /^mediatype:\(audio\) AND -access-restricted-item:true AND downloads:/);

  const bands = await r.call("/api/archive/etree/bands?q=dead", r.h.alice);
  assert.equal(bands.statusCode, 200);
  assert.match(new URL(r.site.seen.at(-1)!.url, "http://x").searchParams.get("q")!, /^mediatype:\(collection\) AND collection:\(etree\) AND/);
  await r.close();
});

test("search: Archive being down is a fixed message", async () => {
  const r = await rig();
  await r.site.close();
  const res = await r.call("/api/archive/search?q=anything", r.h.alice);
  assert.equal(res.statusCode, 502);
  assert.ok(!res.body.includes("127.0.0.1"));
  await r.h.close();
  await r.other.close();
});

test("item: tracks, licence, attribution and show details; restricted and silent items refused", async () => {
  const r = await rig();
  const res = await r.call("/api/archive/items/gd77-05-08", r.h.alice);
  assert.equal(res.statusCode, 200, res.body);
  const item = res.json();
  assert.equal(item.title, "Grateful Dead Live at Barton Hall on 1977-05-08");
  assert.equal(item.creator, "Grateful Dead");
  assert.equal(item.venue, "Barton Hall");
  assert.equal(item.taper, "Betty Cantor");
  assert.equal(item.description, "A famous show .");
  assert.deepEqual(item.collections, ["etree", "GratefulDead"]);
  assert.deepEqual(item.formats.sort(), ["flac", "mp3", "ogg"]);
  assert.equal(item.format, "mp3");
  assert.equal(item.tracks.length, 3);
  assert.equal(item.tracks[0].title, "New Minglewood Blues");
  assert.match(item.tracks[0].path, /^api\/archive\/stream\/gd77-05-08\?f=gd77-05-08d1t01\.mp3&u=\d+&exp=\d+&sig=/);
  assert.deepEqual(item.attribution.licence, { name: "CC BY-NC-SA 3.0", url: "http://creativecommons.org/licenses/by-nc-sa/3.0/" });
  assert.equal(item.attribution.detailsUrl, "https://archive.org/details/gd77-05-08");
  assert.equal(item.attribution.text, "Grateful Dead Live at Barton Hall on 1977-05-08 by Grateful Dead, from the Internet Archive, CC BY-NC-SA 3.0");
  assert.ok(!res.body.includes(r.site.url), "the origin address is not exposed");
  assert.equal((await r.call("/api/archive/items/gd77-05-08?format=ogg", r.h.alice)).json().format, "ogg");
  assert.equal((await r.call("/api/archive/items/lending", r.h.alice)).statusCode, 403);
  assert.equal((await r.call("/api/archive/items/lending", r.h.alice)).json().error, "restricted");
  assert.equal((await r.call("/api/archive/items/silent", r.h.alice)).statusCode, 404);
  assert.equal((await r.call("/api/archive/items/nothing-here", r.h.alice)).statusCode, 404);
  assert.equal((await r.call("/api/archive/items/..%2Fetc", r.h.alice)).statusCode, 400);
  assert.equal((await r.call("/api/archive/items/gd77-05-08", null)).statusCode, 401);
  await r.close();
});

test("stream: derivative audio through the proxy with Range support; only listed files, signed, redirects stay on archive.org", async () => {
  const r = await rig();
  const item = (await r.call("/api/archive/items/gd77-05-08", r.h.alice)).json() as { tracks: { path: string }[] };
  const t1 = `/${item.tracks[0].path}`;
  const full = await r.call(t1, null);
  assert.equal(full.statusCode, 200);
  assert.equal(full.headers["content-type"], "audio/mpeg");
  assert.equal(full.rawPayload.equals(AUDIO), true);
  const part = await r.call(t1, null, { range: "bytes=2-6" });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers["content-range"], `bytes 2-6/${AUDIO.length}`);
  assert.equal(part.payload, "23456");
  assert.equal(r.site.seen.at(-1)!.headers.range, "bytes=2-6");
  // file names with folders
  assert.equal((await r.call(`/${item.tracks[2].path}`, null)).payload, "bonus");
  // a redirect away from archive.org's hosts is refused and the other service is never contacted
  const t2 = await r.call(`/${item.tracks[1].path}`, null);
  assert.equal(t2.statusCode, 502);
  assert.equal(t2.json().error, "upstream_failed");
  assert.equal(r.other.seen.length, 0);
  // signatures
  const noSig = await r.call("/api/archive/stream/gd77-05-08?f=gd77-05-08d1t01.mp3", null);
  assert.equal(noSig.statusCode, 403);
  assert.equal((await r.call(t1.replace("t01.mp3", "t02.mp3"), null)).statusCode, 403, "bound to the file");
  assert.equal((await r.call(t1.replace(/exp=\d+/, "exp=1"), null)).statusCode, 403);
  assert.equal((await r.call(t1, r.h.bob)).statusCode, 200, "the signed URL is the credential");
  // a file the item's metadata does not list as audio (even with a valid-looking signature scheme) is not fetched
  const sigOnly = t1.slice(t1.indexOf("&u="));
  assert.equal((await r.call(`/api/archive/stream/gd77-05-08?f=..%2F..%2Fetc%2Fpasswd${sigOnly}`, null)).statusCode, 403);
  assert.equal((await r.call(`/api/archive/stream/gd77-05-08?f=gd77-05-08.jpg${sigOnly}`, null)).statusCode, 403);
  assert.equal((await r.call("/api/archive/stream/bad%20id?f=a.mp3", null)).statusCode, 400);
  await r.close();
});

test("stream: a signed request for a file that is not audio in the metadata is refused", async () => {
  const r = await rig();
  // sign a request for the cover image file by borrowing the plugin's own signer via the item route of another file name
  const crypto = await import("node:crypto");
  const exp = Math.floor(Date.now() / 1000) + 600;
  const uid = (r.h.db.prepare("SELECT id FROM users WHERE username = 'alice'").get() as { id: number }).id;
  const file = "gd77-05-08.jpg";
  const sig = crypto.createHmac("sha256", "s".repeat(64)).update(`archive-stream\n${uid}\ngd77-05-08\n${file}\n${exp}`).digest("base64url");
  const res = await r.call(`/api/archive/stream/gd77-05-08?f=${file}&u=${uid}&exp=${exp}&sig=${sig}`, null);
  assert.equal(res.statusCode, 404, "valid signature, but not a listed audio file");
  const lend = crypto.createHmac("sha256", "s".repeat(64)).update(`archive-stream\n${uid}\nlending\na.mp3\n${exp}`).digest("base64url");
  assert.equal((await r.call(`/api/archive/stream/lending?f=a.mp3&u=${uid}&exp=${exp}&sig=${lend}`, null)).statusCode, 404, "restricted items never stream");
  await r.close();
});

test("cover art is proxied and signed", async () => {
  const r = await rig();
  const search = (await r.call("/api/archive/search?q=dead", r.h.alice)).json() as { items: { cover: string }[] };
  const img = await r.call(`/${search.items[0].cover}`, null);
  assert.equal(img.statusCode, 200);
  assert.equal(img.headers["content-type"], "image/jpeg");
  assert.equal(img.rawPayload.equals(JPG), true);
  assert.equal((await r.call("/api/archive/image/gd77-05-08", null)).statusCode, 403);
  await r.close();
});