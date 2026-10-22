import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createLocalUser } from "../auth/users.js";
import { openDb } from "../db.js";
import { open, seal } from "../llm/secretBox.js";
import { RemoteError, runIndex, type IndexDriver, type RemoteFile } from "./indexer.js";
import { checkAddress, classifyAddress, parseSourceUrl, precheckUrl, readBody, request, SourceNetError } from "./net.js";
import { signedStreamPath, verifySignedStream } from "./signing.js";
import { ensureSourceTables, SourceStore, trackIdFor } from "./store.js";
import { parseRange } from "./stream.js";
import { fallbackTags, readTags, titleFromName } from "./tags.js";
import { makeMp3, MP3_FRAME_BYTES } from "./testAudio.js";
import { child, childText, parseXml, XmlError } from "./xml.js";

const SECRET = "s".repeat(64);

// ---- addresses (SSRF) ---------------------------------------------------------------

test("classifies addresses: public, private and always-blocked", () => {
  const cases: [string, string][] = [
    ["8.8.8.8", "public"],
    ["93.184.216.34", "public"],
    ["127.0.0.1", "private"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.1", "public"],
    ["192.168.1.10", "private"],
    ["100.64.0.5", "private"],
    ["169.254.169.254", "blocked"],
    ["0.0.0.0", "blocked"],
    ["224.0.0.1", "blocked"],
    ["255.255.255.255", "blocked"],
    ["::1", "private"],
    ["::", "blocked"],
    ["fe80::1", "blocked"],
    ["fc00::1", "private"],
    ["fd12:3456::1", "private"],
    ["2606:4700:4700::1111", "public"],
    ["::ffff:127.0.0.1", "private"],
    ["::ffff:7f00:1", "private"],
    ["::ffff:169.254.169.254", "blocked"],
    ["::ffff:8.8.8.8", "public"],
    ["64:ff9b::7f00:1", "private"],
    ["not-an-ip", "blocked"],
  ];
  for (const [ip, want] of cases) assert.equal(classifyAddress(ip), want, ip);
});

test("a policy decides about private networks and plain http", () => {
  assert.throws(() => checkAddress("10.0.0.5", "https:", { allowPrivate: false }), /blocked/);
  assert.doesNotThrow(() => checkAddress("10.0.0.5", "http:", { allowPrivate: true }));
  assert.doesNotThrow(() => checkAddress("8.8.8.8", "https:", { allowPrivate: false }));
  assert.throws(() => checkAddress("8.8.8.8", "http:", { allowPrivate: false }), /insecure/);
  // The cloud metadata address is never reachable, whatever the owner allows.
  assert.throws(() => checkAddress("169.254.169.254", "http:", { allowPrivate: true }), /blocked/);
  assert.throws(() => precheckUrl(new URL("http://169.254.169.254/latest"), { allowPrivate: true }), /blocked/);
  assert.throws(() => precheckUrl(new URL("https://127.0.0.1/"), { allowPrivate: false }), /blocked/);
  assert.throws(() => precheckUrl(new URL("http://example.com/"), { allowPrivate: false }), /insecure/);
  assert.throws(() => precheckUrl(new URL("https://[::1]/"), { allowPrivate: false }), /blocked/);
});

test("odd spellings of loopback are still loopback", () => {
  for (const spelling of ["http://2130706433/", "http://0x7f.0.0.1/", "http://127.1/", "http://0177.0.0.1/", "http://[::ffff:7f00:1]/"]) {
    const url = parseSourceUrl(spelling);
    assert.throws(() => precheckUrl(url, { allowPrivate: false }), SourceNetError, spelling);
  }
});

test("rejects addresses with credentials, odd schemes, queries and junk", () => {
  for (const bad of ["", "ftp://x.example/", "file:///etc/passwd", "https://user:pw@x.example/", "https://x.example/?a=1", "https://x.example/#f", "not a url", "javascript:alert(1)"]) {
    assert.throws(() => parseSourceUrl(bad), SourceNetError, bad);
  }
  assert.equal(parseSourceUrl("https://dav.example/remote.php/dav/files/me/").hostname, "dav.example");
});

async function server(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const s = http.createServer(handler);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        s.closeAllConnections();
        s.close(() => r());
      }),
  };
}

test("refuses to connect to loopback unless the owner allows it, and never follows a redirect there", async () => {
  const inner = await server((_req, res) => res.end("secret"));
  const outer = await server((_req, res) => {
    res.writeHead(302, { Location: inner.url + "/x" });
    res.end();
  });
  try {
    await assert.rejects(request(inner.url, { policy: { allowPrivate: false } }), (e) => e instanceof SourceNetError && e.kind === "blocked");
    const ok = await request(inner.url, { policy: { allowPrivate: true } });
    assert.equal((await readBody(ok, 100)).toString(), "secret");
    // With private networks allowed the redirect is followed; without, the first hop is already refused.
    await assert.rejects(request(outer.url, { policy: { allowPrivate: false } }), SourceNetError);
  } finally {
    await inner.close();
    await outer.close();
  }
});

test("a hostname that resolves to loopback is refused (checked at connect time)", async () => {
  // "localhost" resolves to 127.0.0.1 / ::1 via the system resolver.
  await assert.rejects(request("http://localhost:9/", { policy: { allowPrivate: false } }), (e) => e instanceof SourceNetError && (e.kind === "blocked" || e.kind === "insecure"));
});

test("credentials are not sent to another origin after a redirect, but Range is", async () => {
  const seen: http.IncomingHttpHeaders[] = [];
  const target = await server((req, res) => {
    seen.push(req.headers);
    res.end("ok");
  });
  // "localhost" is a different origin from 127.0.0.1 (same machine, different host name).
  const port = new URL(target.url).port;
  const origin = await server((_req, res) => {
    res.writeHead(307, { Location: `http://localhost:${port}/file` });
    res.end();
  });
  try {
    const res = await request(origin.url, { policy: { allowPrivate: true }, headers: { Authorization: "Basic abc", Range: "bytes=0-9", Cookie: "a=b" }, crossOriginHeaders: ["Range"] });
    await readBody(res, 100);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.authorization, undefined);
    assert.equal(seen[0]!.cookie, undefined);
    assert.equal(seen[0]!.range, "bytes=0-9");
  } finally {
    await origin.close();
    await target.close();
  }
});

test("gives up on a response that is too large and on too many redirects", async () => {
  const big = await server((_req, res) => res.end(Buffer.alloc(5000)));
  const loop = await server((req, res) => {
    res.writeHead(302, { Location: req.url + "x" });
    res.end();
  });
  try {
    const res = await request(big.url, { policy: { allowPrivate: true } });
    await assert.rejects(readBody(res, 1000), (e) => e instanceof SourceNetError && e.kind === "too_large");
    await assert.rejects(request(loop.url, { policy: { allowPrivate: true }, maxRedirects: 3 }), (e) => e instanceof SourceNetError && e.kind === "redirect");
  } finally {
    await big.close();
    await loop.close();
  }
});

// ---- XML ----------------------------------------------------------------------------

test("reads XML with any namespace prefix, entities and CDATA", () => {
  const root = parseXml(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/a%20b/Tom &amp; Jerry.mp3</D:href><d:x><![CDATA[<raw>]]></d:x></D:response></D:multistatus>`);
  assert.equal(root.name, "multistatus");
  const r = child(root, "response")!;
  assert.equal(childText(r, "href"), "/a%20b/Tom & Jerry.mp3");
  assert.equal(childText(r, "x"), "<raw>");
});

test("refuses XML that declares entities and survives hostile nesting", () => {
  assert.throws(() => parseXml(`<!DOCTYPE x [<!ENTITY a "bb">]><x>&a;</x>`), XmlError);
  assert.throws(() => parseXml("<a>".repeat(200)), XmlError);
  assert.throws(() => parseXml(""), XmlError);
  // Unknown entities stay as they are instead of expanding.
  assert.equal(childText(parseXml("<a><b>&unknown;</b></a>"), "b"), "&unknown;");
});

// ---- tags ---------------------------------------------------------------------------

test("reads tags and an estimated duration from the start of an MP3 without the rest", async () => {
  const full = makeMp3({ title: "Blue Hour", artist: "Night Owls", album: "After Dark", albumArtist: "Night Owls", track: 3, frames: 600 });
  const head = full.subarray(0, 4096);
  const tags = await readTags(head, "x/03 - blue.mp3", full.length);
  assert.equal(tags.title, "Blue Hour");
  assert.equal(tags.artist, "Night Owls");
  assert.equal(tags.album, "After Dark");
  assert.equal(tags.albumArtist, "Night Owls");
  assert.equal(tags.trackNo, 3);
  assert.equal(tags.fromTags, true);
  const seconds = (600 * 1152) / 44100;
  assert.ok(tags.durationSec !== null && Math.abs(tags.durationSec - seconds) < 1, `duration ${tags.durationSec} vs ${seconds}`);
});

test("falls back to the file name for files with no tags or that are not audio", async () => {
  assert.equal((await readTags(Buffer.from("not audio at all"), "dir/05 - Some Song.flac", 16)).title, "Some Song");
  assert.equal(titleFromName("/a/b/12_track_name.mp3"), "track name");
  assert.equal(titleFromName("Plain.ogg"), "Plain");
  assert.equal(fallbackTags("x.mp3").fromTags, false);
  const untagged = await readTags(makeMp3({ frames: 50 }), "Mystery.mp3", 50 * MP3_FRAME_BYTES);
  assert.equal(untagged.title, "Mystery");
});

// ---- ranges and signed URLs ---------------------------------------------------------

test("parses single byte ranges", () => {
  assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=50-500", 100), { start: 50, end: 99 });
  assert.equal(parseRange("bytes=100-", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=9-3", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=0-1,5-6", 100), null);
  assert.equal(parseRange("items=0-1", 100), null);
  assert.equal(parseRange(undefined, 100), null);
});

test("signed stream URLs are bound to source, user, track and time", () => {
  const exp = 2_000_000_000;
  const path = signedStreamPath(SECRET, "webdav", "webdav", 7, "abc", exp);
  const q = Object.fromEntries(new URL("http://x/" + path).searchParams) as { u: string; exp: string; sig: string };
  assert.equal(verifySignedStream(SECRET, "webdav", "abc", q, 1_000_000_000), 7);
  assert.equal(verifySignedStream(SECRET, "s3", "abc", q, 1_000_000_000), null, "other source");
  assert.equal(verifySignedStream(SECRET, "webdav", "abd", q, 1_000_000_000), null, "other track");
  assert.equal(verifySignedStream(SECRET, "webdav", "abc", { ...q, u: "8" }, 1_000_000_000), null, "other user");
  assert.equal(verifySignedStream(SECRET, "webdav", "abc", q, 2_000_000_001), null, "expired");
  assert.equal(verifySignedStream("t".repeat(64), "webdav", "abc", q, 1_000_000_000), null, "other secret");
  assert.equal(verifySignedStream(SECRET, "webdav", "abc", {}, 1), null);
});

// ---- encryption ---------------------------------------------------------------------

test("secrets round trip, differ each time, and need the right key and purpose", () => {
  const a = seal("hunter2", SECRET, "p1");
  const b = seal("hunter2", SECRET, "p1");
  assert.notEqual(a, b);
  assert.ok(!a.includes("hunter2"));
  assert.equal(open(a, SECRET, "p1"), "hunter2");
  assert.equal(open(a, "t".repeat(64), "p1"), null);
  assert.equal(open(a, SECRET, "p2"), null);
  assert.equal(open(a.slice(0, -2) + "xx", SECRET, "p1"), null);
});

// ---- indexer: resume and removal ------------------------------------------------------

function memoryDriver(files: Map<string, { data: Buffer; mtimeMs: number }>, hooks: { onRead?: (path: string) => void; failList?: () => boolean; failRead?: (path: string) => boolean } = {}): IndexDriver {
  return {
    async *list() {
      for (const [path, f] of files) {
        yield { path, location: path.replace(/^\//, ""), size: f.data.length, mtimeMs: f.mtimeMs } satisfies RemoteFile;
        if (hooks.failList?.()) throw new RemoteError("upstream", "listing broke");
      }
    },
    async readHead(file, bytes) {
      hooks.onRead?.(file.path);
      if (hooks.failRead?.(file.path)) throw new RemoteError("upstream");
      return files.get(file.path)!.data.subarray(0, bytes);
    },
  };
}

async function setupIndex() {
  const db = openDb(":memory:");
  const user = await createLocalUser(db, { username: "idx", password: "idx-password" });
  ensureSourceTables(db);
  return { db, userId: user.id, store: new SourceStore(db, "mem") };
}

test("indexes files, reads tags only for new or changed ones, and removes what disappeared", async () => {
  const { userId, store } = await setupIndex();
  const files = new Map([
    ["/a/one.mp3", { data: makeMp3({ title: "One", artist: "A", album: "X", track: 1 }), mtimeMs: 1000 }],
    ["/a/two.mp3", { data: makeMp3({ title: "Two", artist: "A", album: "X", track: 2 }), mtimeMs: 1000 }],
    ["/b/three.mp3", { data: makeMp3({ title: "Three", artist: "B", album: "Y" }), mtimeMs: 1000 }],
  ]);
  const reads: string[] = [];
  const driver = memoryDriver(files, { onRead: (p) => reads.push(p) });

  const first = await runIndex(store, userId, driver);
  assert.equal(first.status, "done");
  assert.equal(first.found, 3);
  assert.equal(first.indexed, 3);
  assert.equal(store.count(userId), 3);
  assert.deepEqual(store.list(userId, { limit: 10, offset: 0 }).items.map((t) => t.title), ["One", "Two", "Three"]);

  // Nothing changed: nothing is read again.
  reads.length = 0;
  const second = await runIndex(store, userId, driver);
  assert.equal(second.indexed, 0);
  assert.deepEqual(reads, []);

  // One edited (new mtime), one removed, one added.
  files.set("/a/two.mp3", { data: makeMp3({ title: "Two (remaster)", artist: "A", album: "X", track: 2 }), mtimeMs: 2000 });
  files.delete("/b/three.mp3");
  files.set("/c/four.mp3", { data: makeMp3({ title: "Four" }), mtimeMs: 1000 });
  reads.length = 0;
  const third = await runIndex(store, userId, driver);
  assert.deepEqual(reads.sort(), ["/a/two.mp3", "/c/four.mp3"]);
  assert.equal(third.removed, 1);
  const titles = store.list(userId, { limit: 10, offset: 0 }).items.map((t) => t.title).sort();
  assert.deepEqual(titles, ["Four", "One", "Two (remaster)"]);
});

test("a run that stops midway keeps its work, and the next run finishes only what is left (resume)", async () => {
  const { userId, store } = await setupIndex();
  const files = new Map<string, { data: Buffer; mtimeMs: number }>();
  for (let i = 1; i <= 10; i++) files.set(`/m/${String(i).padStart(2, "0")}.mp3`, { data: makeMp3({ title: `T${i}` }), mtimeMs: 5 });
  const ac = new AbortController();
  let reads = 0;
  const driver = memoryDriver(files, {
    onRead: () => {
      if (++reads === 4) ac.abort(); // the server stops after four files
    },
  });
  const cut = await runIndex(store, userId, driver, { batchSize: 2, concurrency: 1, signal: ac.signal });
  assert.equal(cut.status, "interrupted");
  const saved = store.count(userId);
  assert.ok(saved >= 2 && saved < 10, `saved ${saved}`);

  const reads2: string[] = [];
  const resumed = await runIndex(store, userId, memoryDriver(files, { onRead: (p) => reads2.push(p) }), { batchSize: 2, concurrency: 1 });
  assert.equal(resumed.status, "done");
  assert.equal(store.count(userId), 10);
  assert.equal(reads2.length, 10 - saved, "only the files not yet saved are read");
});

test("a failed listing removes nothing; files that fail to read are retried next time", async () => {
  const { userId, store } = await setupIndex();
  const files = new Map([
    ["/a.mp3", { data: makeMp3({ title: "A" }), mtimeMs: 1 }],
    ["/b.mp3", { data: makeMp3({ title: "B" }), mtimeMs: 1 }],
  ]);
  await runIndex(store, userId, memoryDriver(files));
  assert.equal(store.count(userId), 2);

  // The listing breaks after the first file: this must not look like "b.mp3 was deleted".
  const broken = await runIndex(store, userId, memoryDriver(files, { failList: () => true }));
  assert.equal(broken.status, "failed");
  assert.equal(broken.error, "upstream");
  assert.equal(store.count(userId), 2);
  assert.equal(store.run(userId)!.status, "failed");

  // A new file that can't be read right now is skipped, then picked up when it can.
  files.set("/c.mp3", { data: makeMp3({ title: "C" }), mtimeMs: 1 });
  const flaky = await runIndex(store, userId, memoryDriver(files, { failRead: (p) => p === "/c.mp3" }));
  assert.equal(flaky.status, "done");
  assert.equal(flaky.failed, 1);
  assert.equal(store.count(userId), 2);
  const fixed = await runIndex(store, userId, memoryDriver(files));
  assert.equal(fixed.indexed, 1);
  assert.equal(store.count(userId), 3);
});

test("cached tracks are scoped to the person and the source, and search escapes wildcards", async () => {
  const { db, userId, store } = await setupIndex();
  const other = await createLocalUser(db, { username: "other", password: "other-password" });
  const mine = new SourceStore(db, "mem");
  const theirs = new SourceStore(db, "mem");
  const elsewhere = new SourceStore(db, "other-source");
  const row = (title: string) => ({
    id: trackIdFor("mem", userId, title), path: `/${title}`, location: title, title, artist: null, album: null, albumArtist: null,
    trackNo: null, durationSec: null, size: 1, mtimeMs: 1, etag: null, fromTags: true,
  });
  mine.upsert(userId, [row("100% Pure"), row("Plain")]);
  assert.equal(theirs.count(other.id), 0);
  assert.equal(elsewhere.count(userId), 0);
  assert.deepEqual(store.list(userId, { q: "100%", limit: 10, offset: 0 }).items.map((t) => t.title), ["100% Pure"]);
  assert.equal(store.list(userId, { q: "%", limit: 10, offset: 0 }).total, 1, "% is not a wildcard");
  assert.equal(store.get(other.id, row("Plain").id), null);
  // Deleting a user removes their cache.
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  assert.equal(mine.count(userId), 0);
});
