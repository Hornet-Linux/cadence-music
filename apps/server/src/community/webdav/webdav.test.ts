import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { createLocalUser } from "../../auth/users.js";
import type { Config } from "../../config.js";
import { openDb, type Db } from "../../db.js";
import { open } from "../../llm/secretBox.js";
import { makeMp3 } from "../../sources/testAudio.js";
import { parseMultistatus, davUrl, normalizeDavPath } from "./client.js";
import { FakeWebdav } from "./fakeWebdav.js";
import { createWebdavPlugin, WEBDAV_PLUGIN_ID, type WebdavPluginOptions } from "./plugin.js";

const count = (db: Db, sql: string) => (db.prepare(sql).get() as { n: number }).n;
const SECRET = "s".repeat(64);
const ALLOW = { SOURCES_ALLOW_PRIVATE_NETWORK: "true" } as NodeJS.ProcessEnv;
const NOTHING = {} as NodeJS.ProcessEnv;

interface TrackDto {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  trackNo: number | null;
  durationSec: number | null;
  location: string | null;
}

async function setup(opts: WebdavPluginOptions = { env: ALLOW, maxConnectAttempts: 1000 }) {
  const db: Db = openDb(":memory:");
  await createLocalUser(db, { username: "admin", password: "admin-password", isAdmin: true });
  await createLocalUser(db, { username: "alice", password: "alice-password" });
  await createLocalUser(db, { username: "bob", password: "bob-password" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-dav-"));
  const config: Config = { host: "127.0.0.1", port: 0, dataDir: dir, musicDir: dir, scanIntervalMinutes: 0, trustProxy: false, logLevel: "silent" };
  const app = await buildApp({ config, db, secret: SECRET, logger: false, plugins: [createWebdavPlugin(opts)] });
  const signIn = async (username: string) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: `${username}-password` } });
    return { authorization: `Bearer ${(res.json() as { token: string }).token}` };
  };
  return { app, db, admin: await signIn("admin"), alice: await signIn("alice"), bob: await signIn("bob") };
}

function library(dav: FakeWebdav): FakeWebdav {
  return dav
    .add("/Music/Night Owls/After Dark/01 Blue Hour.mp3", makeMp3({ title: "Blue Hour", artist: "Night Owls", album: "After Dark", track: 1, frames: 200 }))
    .add("/Music/Night Owls/After Dark/02 Moth.mp3", makeMp3({ title: "Moth", artist: "Night Owls", album: "After Dark", track: 2, frames: 200 }))
    .add("/Music/Solo/Single/Only Song.mp3", makeMp3({ title: "Only Song & More", artist: "Solo", album: "Single", frames: 100 }))
    .add("/Music/Solo/Single/cover.jpg", Buffer.from("jpeg"))
    .add("/Music/Solo/.hidden/Secret.mp3", makeMp3({ title: "Secret", frames: 10 }))
    .add("/Documents/notes.txt", Buffer.from("not music"))
    .add("/Other/Elsewhere.mp3", makeMp3({ title: "Elsewhere", artist: "Else", frames: 50 }));
}

async function connect(app: FastifyInstance, headers: { authorization: string }, dav: FakeWebdav, extra: Record<string, unknown> = {}) {
  return app.inject({ method: "PUT", url: "/api/webdav/connection", headers, payload: { url: dav.url + "/", username: "alice", password: "app-password", ...extra } });
}

async function indexNow(app: FastifyInstance, headers: { authorization: string }) {
  const res = await app.inject({ method: "POST", url: "/api/webdav/index?wait=1", headers });
  assert.equal(res.statusCode, 200);
  return res.json() as { indexing: { status: string; found: number; indexed: number; removed: number; failed: number }; trackCount: number };
}

/**
 * Wait until the index that a folder change starts in the background has finished, so the next
 * explicit index is a fresh run. (A fixed 50 ms sleep was not enough on a busy machine: the explicit
 * index then joined the background run and reported its removals.)
 */
async function lastFinished(app: FastifyInstance, headers: { authorization: string }) {
  return ((await app.inject({ method: "GET", url: "/api/webdav/status", headers })).json() as { indexing: { running: boolean; finishedAt: number | null } }).indexing;
}
async function settle(app: FastifyInstance, headers: { authorization: string }, before: number | null) {
  for (let i = 0; i < 400; i++) {
    const st = await lastFinished(app, headers);
    if (!st.running && st.finishedAt !== before) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail("the background index did not finish");
}

async function tracks(app: FastifyInstance, headers: { authorization: string }, query = "") {
  const res = await app.inject({ method: "GET", url: `/api/webdav/tracks${query}`, headers });
  assert.equal(res.statusCode, 200);
  return res.json() as { items: TrackDto[]; total: number };
}

async function streamPath(app: FastifyInstance, headers: { authorization: string }, id: string): Promise<string> {
  const res = await app.inject({ method: "GET", url: `/api/webdav/tracks/${id}/stream-url`, headers });
  assert.equal(res.statusCode, 200);
  return "/" + (res.json() as { path: string }).path;
}

test("connects, indexes the share, and lists tracks with tags from the files", async () => {
  const dav = library(await new FakeWebdav().start());
  const { app, alice } = await setup();
  try {
    const res = await connect(app, alice, dav);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as Record<string, unknown>;
    assert.equal(body.connected, true);
    assert.ok(!JSON.stringify(body).includes("app-password"));

    const done = await indexNow(app, alice);
    assert.equal(done.indexing.status, "done");
    assert.equal(done.indexing.found, 4, "audio only; hidden folders, images and notes are skipped");
    assert.equal(done.trackCount, 4);

    const all = await tracks(app, alice);
    assert.equal(all.total, 4);
    const blue = all.items.find((t) => t.title === "Blue Hour")!;
    assert.equal(blue.artist, "Night Owls");
    assert.equal(blue.album, "After Dark");
    assert.equal(blue.trackNo, 1);
    assert.equal(blue.location, "Music/Night Owls/After Dark/01 Blue Hour.mp3");
    assert.ok(blue.durationSec !== null && Math.abs(blue.durationSec - (200 * 1152) / 44100) < 0.5, `duration ${blue.durationSec}`);
    assert.ok(all.items.some((t) => t.title === "Only Song & More"), "XML entities in names are decoded");

    assert.deepEqual((await tracks(app, alice, "?q=moth")).items.map((t) => t.title), ["Moth"]);
    assert.deepEqual((await tracks(app, alice, "?album=After%20Dark")).items.map((t) => t.title), ["Blue Hour", "Moth"]);
    assert.equal((await tracks(app, alice, "?limit=1&offset=1")).items.length, 1);

    const albums = (await app.inject({ method: "GET", url: "/api/webdav/albums", headers: alice })).json() as { items: { name: string; trackCount: number }[] };
    assert.deepEqual(albums.items.map((a) => `${a.name}:${a.trackCount}`), ["After Dark:2", "Single:1"]);
  } finally {
    await app.close();
    await dav.stop();
  }
});

test("the password is encrypted at rest and never returned", async () => {
  const dav = library(await new FakeWebdav().start());
  const { app, db, alice } = await setup();
  try {
    await connect(app, alice, dav);
    const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE ?").all(`plugin:${WEBDAV_PLUGIN_ID}:user:%`) as { key: string; value: string }[];
    assert.equal(rows.length, 1);
    assert.ok(!rows[0]!.value.includes("app-password"), "no plain text in the database");
    const stored = JSON.parse(rows[0]!.value) as { passwordEnc: string; username: string };
    assert.equal(stored.username, "alice");
    assert.equal(open(stored.passwordEnc, SECRET, "cadence-webdav-passwords"), "app-password");
    assert.equal(open(stored.passwordEnc, "x".repeat(64), "cadence-webdav-passwords"), null);

    const status = await app.inject({ method: "GET", url: "/api/webdav/status", headers: alice });
    assert.ok(!status.body.includes("app-password") && !status.body.includes(stored.passwordEnc));
    assert.equal((status.json() as { username: string }).username, "alice");
  } finally {
    await app.close();
    await dav.stop();
  }
});

test("a server secret that changed turns the saved connection into 'not connected' instead of failing", async () => {
  const dav = library(await new FakeWebdav().start());
  const { app, db, alice } = await setup();
  try {
    await connect(app, alice, dav);
    const key = `plugin:${WEBDAV_PLUGIN_ID}:user:2`;
    const row = db.prepare("SELECT key, value FROM settings WHERE key LIKE ?").get(`plugin:${WEBDAV_PLUGIN_ID}:user:%`) as { key: string; value: string };
    const stored = JSON.parse(row.value) as { passwordEnc: string };
    stored.passwordEnc = stored.passwordEnc.slice(0, -3) + "AAA";
    db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(stored), row.key);
    void key;
    const status = (await app.inject({ method: "GET", url: "/api/webdav/status", headers: alice })).json() as { connected: boolean };
    assert.equal(status.connected, false);
  } finally {
    await app.close();
    await dav.stop();
  }
});

test("streams through the server with byte ranges, and cuts the range itself when the share ignores it", async () => {
  const dav = library(await new FakeWebdav().start());
  const { app, alice } = await setup();
  try {
    await connect(app, alice, dav);
    await indexNow(app, alice);
    const blue = (await tracks(app, alice, "?q=Blue")).items[0]!;
    const data = dav.files.get("/Music/Night Owls/After Dark/01 Blue Hour.mp3")!.data;
    const url = await streamPath(app, alice, blue.id);

    const whole = await app.inject({ method: "GET", url });
    assert.equal(whole.statusCode, 200);
    assert.equal(whole.headers["content-type"], "audio/mpeg");
    assert.equal(whole.headers["accept-ranges"], "bytes");
    assert.deepEqual(whole.rawPayload, data);

    const part = await app.inject({ method: "GET", url, headers: { range: "bytes=100-199" } });
    assert.equal(part.statusCode, 206);
    assert.equal(part.headers["content-range"], `bytes 100-199/${data.length}`);
    assert.deepEqual(part.rawPayload, data.subarray(100, 200));

    const tail = await app.inject({ method: "GET", url, headers: { range: "bytes=-50" } });
    assert.equal(tail.statusCode, 206);
    assert.deepEqual(tail.rawPayload, data.subarray(data.length - 50));

    const open = await app.inject({ method: "GET", url, headers: { range: `bytes=${data.length - 10}-` } });
    assert.deepEqual(open.rawPayload, data.subarray(data.length - 10));

    const beyond = await app.inject({ method: "GET", url, headers: { range: `bytes=${data.length + 5}-` } });
    assert.equal(beyond.statusCode, 416);

    // A share that ignores Range and answers 200 with the whole file.
    dav.ignoreRange = true;
    const sliced = await app.inject({ method: "GET", url, headers: { range: "bytes=1000-1099" } });
    assert.equal(sliced.statusCode, 206);
    assert.equal(sliced.headers["content-range"], `bytes 1000-1099/${data.length}`);
    assert.equal(sliced.headers["content-length"], "100");
    assert.deepEqual(sliced.rawPayload, data.subarray(1000, 1100));
    const slicedTail = await app.inject({ method: "GET", url, headers: { range: "bytes=-20" } });
    assert.deepEqual(slicedTail.rawPayload, data.subarray(data.length - 20));
    assert.ok(dav.calls.some((c) => c.method === "GET" && c.range === "bytes=100-199"), "the range was passed to the share");
  } finally {
    await app.close();
    await dav.stop();
  }
});

test("stream links need a valid signature, belong to one person, and expire", async () => {
  const dav = library(await new FakeWebdav().start());
  const { app, alice, bob } = await setup();
  try {
    await connect(app, alice, dav);
    await indexNow(app, alice);
    const id = (await tracks(app, alice)).items[0]!.id;
    const url = await streamPath(app, alice, id);

    assert.equal((await app.inject({ method: "GET", url: `/api/webdav/stream/${id}` })).statusCode, 403);
    assert.equal((await app.inject({ method: "GET", url: url.replace(/sig=[^&]+/, "sig=AAAA") })).statusCode, 403);
    assert.equal((await app.inject({ method: "GET", url: url.replace(/exp=\d+/, "exp=1") })).statusCode, 403);
    // Bob swapping his own id into Alice's link is refused (the signature binds the user).
    assert.equal((await app.inject({ method: "GET", url: url.replace(/u=\d+/, "u=3") })).statusCode, 403);
    assert.equal((await app.inject({ method: "GET", url: `/api/webdav/stream/not-a-track?u=2&exp=9999999999&sig=x` })).statusCode, 403);

    // Bob can't see Alice's tracks or get a link for them.
    assert.equal((await tracks(app, bob)).total, 0);
    assert.equal((await app.inject({ method: "GET", url: `/api/webdav/tracks/${id}/stream-url`, headers: bob })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/api/webdav/tracks" })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/api/webdav/status" })).statusCode, 401);
  } finally {
    await app.close();
    await dav.stop();
  }
});

test("wrong password: nothing is saved, and the answer is not a 401 (that would sign the person out of Cadence)", async () => {
  const dav = library(await new FakeWebdav().start());
  const { app, db, alice } = await setup();
  try {
    const res = await app.inject({ method: "PUT", url: "/api/webdav/connection", headers: alice, payload: { url: dav.url, username: "alice", password: "nope" } });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { error: string }).error, "webdav_bad_credentials");
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'plugin:cadence.webdav:user:%'"), 0);
    const nowhere = await app.inject({ method: "PUT", url: "/api/webdav/connection", headers: alice, payload: { url: dav.url.replace("/dav", "/missing"), username: "alice", password: "app-password" } });
    assert.equal(nowhere.statusCode, 400);
    const bad = await app.inject({ method: "PUT", url: "/api/webdav/connection", headers: alice, payload: { url: dav.url } });
    assert.equal(bad.statusCode, 400);
    dav.propfindStatus = 500;
    const broken = await connect(app, alice, dav);
    assert.equal(broken.statusCode, 502);
    assert.ok(!broken.body.includes("500"), "no upstream details");
  } finally {
    await app.close();
    await dav.stop();
  }
});

test("SSRF: private and metadata addresses are refused unless the owner allows private networks", async () => {
  const dav = library(await new FakeWebdav().start());
  const strict = await setup({ env: NOTHING, maxConnectAttempts: 1000 });
  try {
    for (const url of [dav.url, "http://localhost:9/dav", "http://169.254.169.254/latest/meta-data/", "https://[::1]/dav", "http://10.0.0.5/dav", "http://example.com/dav"]) {
      const res = await connect(strict.app, strict.alice, Object.assign(Object.create(dav), { url }) as FakeWebdav);
      assert.equal(res.statusCode, 400, url);
      assert.equal((res.json() as { error: string }).error, "address_not_allowed", url);
    }
    for (const url of ["ftp://x.example/", "file:///etc/passwd", "https://user:pw@example.com/dav", "not a url"]) {
      const res = await connect(strict.app, strict.alice, Object.assign(Object.create(dav), { url }) as FakeWebdav);
      assert.equal(res.statusCode, 400, url);
      assert.equal((res.json() as { error: string }).error, "invalid_address", url);
    }
    assert.equal(dav.calls.length, 0, "the share was never contacted");

    // Only the owner can flip the switch, and then the LAN share works. The metadata address never does.
    assert.equal((await strict.app.inject({ method: "PUT", url: "/api/webdav/admin", headers: strict.alice, payload: { allowPrivateNetwork: true } })).statusCode, 403);
    assert.equal((await strict.app.inject({ method: "GET", url: "/api/webdav/admin", headers: strict.alice })).statusCode, 403);
    assert.equal((await strict.app.inject({ method: "PUT", url: "/api/webdav/admin", headers: strict.admin, payload: { allowPrivateNetwork: "yes" } })).statusCode, 400);
    const on = await strict.app.inject({ method: "PUT", url: "/api/webdav/admin", headers: strict.admin, payload: { allowPrivateNetwork: true } });
    assert.deepEqual(on.json(), { allowPrivateNetwork: true, source: "admin" });
    assert.equal((await connect(strict.app, strict.alice, dav)).statusCode, 200);
    const meta = await connect(strict.app, strict.alice, Object.assign(Object.create(dav), { url: "http://169.254.169.254/latest" }) as FakeWebdav);
    assert.equal(meta.statusCode, 400);
  } finally {
    await strict.app.close();
    await dav.stop();
  }
});

test("a share that lists addresses on other hosts or outside the base cannot make the server fetch them", async () => {
  const dav = library(await new FakeWebdav().start());
  dav.hostile = true;
  const { app, alice } = await setup();
  try {
    await connect(app, alice, dav);
    const done = await indexNow(app, alice);
    assert.equal(done.indexing.found, 4);
    assert.ok(dav.calls.every((c) => c.path.startsWith("/dav")), "only paths under the base were requested");
    assert.ok(!(await tracks(app, alice)).items.some((t) => /steal|passwd|evil|^elsewhere/i.test(t.location ?? "")));
  } finally {
    await app.close();
    await dav.stop();
  }
});

test("chosen folders limit the index, and dropping a folder removes its tracks; reconnecting keeps the cache", async () => {
  const dav = library(await new FakeWebdav().start());
  const { app, alice } = await setup();
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/webdav/folders", headers: alice })).statusCode, 409, "not connected yet");
    await connect(app, alice, dav, { folders: ["/Music/Solo"] });
    const first = await indexNow(app, alice);
    assert.equal(first.trackCount, 1);

    const root = (await app.inject({ method: "GET", url: "/api/webdav/folders", headers: alice })).json() as { path: string; folders: { name: string; path: string }[] };
    assert.deepEqual(root.folders.map((f) => f.name), ["Documents", "Music", "Other"]);
    const music = (await app.inject({ method: "GET", url: "/api/webdav/folders?path=/Music", headers: alice })).json() as { folders: { name: string; path: string }[] };
    assert.deepEqual(music.folders.map((f) => f.path), ["/Music/Night Owls", "/Music/Solo"]);
    assert.equal((await app.inject({ method: "GET", url: "/api/webdav/folders?path=/a/../../x", headers: alice })).statusCode, 400);

    let before = (await lastFinished(app, alice)).finishedAt;
    const put = await app.inject({ method: "PUT", url: "/api/webdav/folders", headers: alice, payload: { folders: ["/Music/Night Owls", "/Other"] } });
    assert.equal(put.statusCode, 200);
    await settle(app, alice, before);
    const second = await indexNow(app, alice);
    assert.equal(second.trackCount, 3);
    assert.deepEqual((await tracks(app, alice)).items.map((t) => t.title).sort(), ["Blue Hour", "Elsewhere", "Moth"]);
    assert.equal(second.indexing.removed, 0);

    before = (await lastFinished(app, alice)).finishedAt;
    await app.inject({ method: "PUT", url: "/api/webdav/folders", headers: alice, payload: { folders: ["/Other"] } });
    await settle(app, alice, before);
    const third = await indexNow(app, alice);
    assert.equal(third.trackCount, 1);

    assert.equal((await app.inject({ method: "PUT", url: "/api/webdav/folders", headers: alice, payload: { folders: ["../x"] } })).statusCode, 400);
    assert.equal((await app.inject({ method: "PUT", url: "/api/webdav/folders", headers: alice, payload: { folders: "all" } })).statusCode, 400);

    // Connecting again to the same share keeps what was indexed.
    await connect(app, alice, dav, { folders: ["/Other"] });
    assert.equal((await tracks(app, alice)).total, 1);
  } finally {
    await app.close();
    await dav.stop();
  }
});

test("files deleted on the share disappear on the next index; unchanged files are not read again", async () => {
  const dav = library(await new FakeWebdav().start());
  const { app, alice } = await setup();
  try {
    await connect(app, alice, dav);
    await indexNow(app, alice);
    const getsBefore = dav.calls.filter((c) => c.method === "GET").length;
    await indexNow(app, alice);
    assert.equal(dav.calls.filter((c) => c.method === "GET").length, getsBefore, "no tag reads for unchanged files");

    dav.files.delete("/Music/Night Owls/After Dark/02 Moth.mp3");
    dav.add("/Music/Solo/Single/New.mp3", makeMp3({ title: "New One", frames: 30 }));
    const after = await indexNow(app, alice);
    assert.equal(after.indexing.removed, 1);
    assert.equal(after.indexing.indexed, 1);
    assert.deepEqual((await tracks(app, alice)).items.map((t) => t.title).sort(), ["Blue Hour", "Elsewhere", "New One", "Only Song & More"]);

    // When the share is down, the library stays as it was.
    dav.propfindStatus = 503;
    const down = await app.inject({ method: "POST", url: "/api/webdav/index?wait=1", headers: alice });
    assert.equal((down.json() as { indexing: { status: string } }).indexing.status, "failed");
    assert.equal((await tracks(app, alice)).total, 4);
    const status = (await app.inject({ method: "GET", url: "/api/webdav/status", headers: alice })).json() as { indexing: { status: string; error: string } };
    assert.equal(status.indexing.status, "failed");
    assert.equal(status.indexing.error, "upstream");
  } finally {
    await app.close();
    await dav.stop();
  }
});

test("disconnecting forgets the login and the cached tracks", async () => {
  const dav = library(await new FakeWebdav().start());
  const { app, db, alice } = await setup();
  try {
    await connect(app, alice, dav);
    await indexNow(app, alice);
    assert.equal((await app.inject({ method: "DELETE", url: "/api/webdav/connection", headers: alice })).statusCode, 204);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'plugin:cadence.webdav:user:%'"), 0);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM source_tracks"), 0);
    const status = (await app.inject({ method: "GET", url: "/api/webdav/status", headers: alice })).json() as { connected: boolean; trackCount: number };
    assert.equal(status.connected, false);
    assert.equal(status.trackCount, 0);
    assert.equal((await app.inject({ method: "POST", url: "/api/webdav/index", headers: alice })).statusCode, 409);
  } finally {
    await app.close();
    await dav.stop();
  }
});

test("works with servers that answer with plain, prefix-less XML", async () => {
  const dav = library(await new FakeWebdav().start());
  dav.plainXml = true;
  const { app, alice } = await setup();
  try {
    assert.equal((await connect(app, alice, dav)).statusCode, 200);
    assert.equal((await indexNow(app, alice)).trackCount, 4);
  } finally {
    await app.close();
    await dav.stop();
  }
});

test("parses a Nextcloud-style multistatus and keeps only entries under the base", () => {
  const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
 <d:response><d:href>/remote.php/dav/files/me/Music/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <d:response><d:href>/remote.php/dav/files/me/Music/Caf%C3%A9%20Del%20Mar.flac</d:href><d:propstat><d:prop><d:getlastmodified>Tue, 02 Jan 2024 03:04:05 GMT</d:getlastmodified><d:getcontentlength>1234</d:getcontentlength><d:resourcetype/><d:getetag>&quot;abc123&quot;</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><oc:size/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>
 <d:response><d:href>/remote.php/dav/files/someone-else/x.mp3</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;
  const entries = parseMultistatus(xml, "https://cloud.example/remote.php/dav/files/me");
  assert.deepEqual(entries.map((e) => [e.path, e.isDir]), [["/Music", true], ["/Music/Café Del Mar.flac", false]]);
  assert.equal(entries[1]!.size, 1234);
  assert.equal(entries[1]!.etag, "abc123");
  assert.equal(entries[1]!.mtimeMs, Date.UTC(2024, 0, 2, 3, 4, 5));
});

test("builds request addresses safely from stored paths", () => {
  assert.equal(davUrl("https://c.example/dav/me", "/Music/A & B/Ça va.mp3").href, "https://c.example/dav/me/Music/A%20%26%20B/%C3%87a%20va.mp3");
  assert.equal(davUrl("https://c.example/dav/me", "/", true).href, "https://c.example/dav/me/");
  assert.equal(normalizeDavPath("Music//./Rock/"), "/Music/Rock");
  assert.equal(normalizeDavPath("/a/../b"), null);
  assert.equal(normalizeDavPath("/a\\b"), null);
  assert.equal(normalizeDavPath("/a\u0000b"), null);
  assert.throws(() => davUrl("https://c.example/dav", "/x/../../y"));
});

test("limits how often a person can try to connect", async () => {
  const dav = library(await new FakeWebdav().start());
  const { app, alice, bob } = await setup({ env: ALLOW, maxConnectAttempts: 3 });
  try {
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: "PUT", url: "/api/webdav/connection", headers: alice, payload: { url: dav.url, username: "alice", password: "wrong" } });
      assert.equal(res.statusCode, 400);
    }
    const limited = await connect(app, alice, dav);
    assert.equal(limited.statusCode, 429);
    // Someone else is not affected.
    assert.equal((await connect(app, bob, dav)).statusCode, 200);
  } finally {
    await app.close();
    await dav.stop();
  }
});

test("successful connects (like saving chosen folders) never use up the attempt limit", async () => {
  const dav = library(await new FakeWebdav().start());
  const { app, alice } = await setup({ env: ALLOW, maxConnectAttempts: 2 });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await connect(app, alice, dav)).statusCode, 200);
  } finally {
    await app.close();
    await dav.stop();
  }
});
