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
import { isPathStyleByDefault, normalizePrefix, objectUrl } from "./client.js";
import { FakeS3 } from "./fakeS3.js";
import { createS3Plugin, S3_PLUGIN_ID, type S3PluginOptions } from "./plugin.js";

const SECRET = "s".repeat(64);
const ALLOW = { SOURCES_ALLOW_PRIVATE_NETWORK: "true" } as NodeJS.ProcessEnv;
const count = (db: Db, sql: string) => (db.prepare(sql).get() as { n: number }).n;

interface TrackDto {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  location: string | null;
  durationSec: number | null;
}

async function setup(opts: S3PluginOptions = { env: ALLOW, maxConnectAttempts: 1000 }) {
  const db: Db = openDb(":memory:");
  await createLocalUser(db, { username: "admin", password: "admin-password", isAdmin: true });
  await createLocalUser(db, { username: "alice", password: "alice-password" });
  await createLocalUser(db, { username: "bob", password: "bob-password" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-s3-"));
  const config: Config = { host: "127.0.0.1", port: 0, dataDir: dir, musicDir: dir, scanIntervalMinutes: 0, trustProxy: false, logLevel: "silent" };
  const app = await buildApp({ config, db, secret: SECRET, logger: false, plugins: [createS3Plugin(opts)] });
  const signIn = async (username: string) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: `${username}-password` } });
    return { authorization: `Bearer ${(res.json() as { token: string }).token}` };
  };
  return { app, db, admin: await signIn("admin"), alice: await signIn("alice"), bob: await signIn("bob") };
}

function bucket(s3: FakeS3): FakeS3 {
  return s3
    .add("Night Owls/After Dark/01 Blue Hour.mp3", makeMp3({ title: "Blue Hour", artist: "Night Owls", album: "After Dark", track: 1, frames: 200 }))
    .add("Night Owls/After Dark/02 Moth.mp3", makeMp3({ title: "Moth", artist: "Night Owls", album: "After Dark", track: 2, frames: 200 }))
    .add("Night Owls/After Dark/", Buffer.alloc(0))
    .add("Solo & Friends/Café (live) it's.mp3", makeMp3({ title: "Café (live)", artist: "Solo", album: "Singles", frames: 100 }))
    .add("Solo & Friends/cover.jpg", Buffer.from("jpeg"))
    .add("Solo & Friends/.hidden.mp3", makeMp3({ title: "Hidden", frames: 10 }))
    .add("notes.txt", Buffer.from("text"))
    .add("Other/Loose track.mp3", makeMp3({ title: "Loose", artist: "X", frames: 50 }));
}

const body = (s3: FakeS3, extra: Record<string, unknown> = {}) => ({
  endpoint: s3.url,
  region: s3.region,
  bucket: s3.bucket,
  accessKeyId: s3.accessKeyId,
  secretAccessKey: s3.secretAccessKey,
  ...extra,
});

async function connect(app: FastifyInstance, headers: { authorization: string }, s3: FakeS3, extra: Record<string, unknown> = {}) {
  return app.inject({ method: "PUT", url: "/api/s3/connection", headers, payload: body(s3, extra) });
}

async function indexNow(app: FastifyInstance, headers: { authorization: string }) {
  const res = await app.inject({ method: "POST", url: "/api/s3/index?wait=1", headers });
  assert.equal(res.statusCode, 200);
  return res.json() as { indexing: { status: string; found: number; indexed: number; removed: number; error: string | null }; trackCount: number };
}

async function tracks(app: FastifyInstance, headers: { authorization: string }, query = "") {
  const res = await app.inject({ method: "GET", url: `/api/s3/tracks${query}`, headers });
  assert.equal(res.statusCode, 200);
  return res.json() as { items: TrackDto[]; total: number };
}

test("connects, pages through the bucket listing and indexes audio objects with their tags", async () => {
  const s3 = bucket(await new FakeS3().start());
  s3.pageSize = 2; // forces continuation tokens
  const { app, alice } = await setup();
  try {
    const res = await connect(app, alice, s3);
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(!res.body.includes(s3.secretAccessKey));
    const done = await indexNow(app, alice);
    assert.equal(done.indexing.status, "done");
    assert.equal(done.indexing.found, 4, "audio only: no folder markers, images, text or dotfiles");
    assert.ok(s3.calls.filter((c) => c.method === "GET" && c.query["list-type"]).length >= 3, "listing was paged");

    const all = await tracks(app, alice);
    assert.equal(all.total, 4);
    const cafe = all.items.find((t) => t.title === "Café (live)")!;
    assert.equal(cafe.location, "Solo & Friends/Café (live) it's.mp3", "special characters in keys survive signing and listing");
    assert.equal(cafe.artist, "Solo");
    const blue = all.items.find((t) => t.title === "Blue Hour")!;
    assert.ok(blue.durationSec !== null && Math.abs(blue.durationSec - (200 * 1152) / 44100) < 0.5);
  } finally {
    await app.close();
    await s3.stop();
  }
});

test("every call to the bucket is signed; streaming uses a presigned link of at most a minute that the client never sees", async () => {
  const s3 = bucket(await new FakeS3().start());
  const { app, alice } = await setup();
  try {
    await connect(app, alice, s3);
    await indexNow(app, alice);
    assert.ok(s3.calls.every((c) => c.kind !== "unsigned"), "no unsigned requests");
    assert.ok(s3.calls.filter((c) => c.query["list-type"]).every((c) => c.kind === "header"));
    const tagReads = s3.calls.filter((c) => c.method === "GET" && !c.query["list-type"]);
    assert.ok(tagReads.length >= 4);
    assert.ok(tagReads.every((c) => c.kind === "presigned" && !c.hadAuthorizationHeader && (c.expires ?? 999) <= 60 && c.range?.startsWith("bytes=0-")));

    const moth = (await tracks(app, alice, "?q=Moth")).items[0]!;
    const linkRes = await app.inject({ method: "GET", url: `/api/s3/tracks/${moth.id}/stream-url`, headers: alice });
    assert.ok(!linkRes.body.includes("X-Amz"), "the client gets a Cadence link, not a bucket link");
    const url = "/" + (linkRes.json() as { path: string }).path;
    const data = s3.objects.get("Night Owls/After Dark/02 Moth.mp3")!.data;

    s3.calls.length = 0;
    const whole = await app.inject({ method: "GET", url });
    assert.equal(whole.statusCode, 200);
    assert.equal(whole.headers["content-type"], "audio/mpeg");
    assert.deepEqual(whole.rawPayload, data);
    assert.ok(!JSON.stringify(whole.headers).includes("X-Amz"));
    const part = await app.inject({ method: "GET", url, headers: { range: "bytes=500-999" } });
    assert.equal(part.statusCode, 206);
    assert.equal(part.headers["content-range"], `bytes 500-999/${data.length}`);
    assert.deepEqual(part.rawPayload, data.subarray(500, 1000));
    const suffix = await app.inject({ method: "GET", url, headers: { range: "bytes=-100" } });
    assert.deepEqual(suffix.rawPayload, data.subarray(data.length - 100));
    assert.equal((await app.inject({ method: "GET", url, headers: { range: `bytes=${data.length}-` } })).statusCode, 416);
    assert.deepEqual(s3.calls.map((c) => [c.kind, c.range]), [["presigned", undefined], ["presigned", "bytes=500-999"], ["presigned", "bytes=-100"], ["presigned", `bytes=${data.length}-`]]);
  } finally {
    await app.close();
    await s3.stop();
  }
});

test("a presigned link made for streaming stops working after a minute", async () => {
  const s3 = bucket(await new FakeS3().start());
  const { app, alice } = await setup();
  try {
    await connect(app, alice, s3);
    await indexNow(app, alice);
    const first = s3.calls.find((c) => c.kind === "presigned")!;
    assert.equal(first.expires, 60);
    // The fake judges expiry on its own clock: moved two minutes ahead, a link made "now" is dead.
    s3.clock = () => Date.now() + 120_000;
    const id = (await tracks(app, alice)).items[0]!.id;
    const link = (await app.inject({ method: "GET", url: `/api/s3/tracks/${id}/stream-url`, headers: alice })).json() as { path: string };
    const res = await app.inject({ method: "GET", url: "/" + link.path });
    assert.equal(res.statusCode, 502, "the server's own link had already expired by the time the bucket saw it");
    assert.ok(!res.body.includes("Request has expired"), "bucket error text is not passed on");
    s3.clock = () => Date.now();
    assert.equal((await app.inject({ method: "GET", url: "/" + link.path })).statusCode, 200);
  } finally {
    await app.close();
    await s3.stop();
  }
});

test("the secret key is encrypted at rest and never returned", async () => {
  const s3 = bucket(await new FakeS3().start());
  const { app, db, alice } = await setup();
  try {
    await connect(app, alice, s3);
    const row = db.prepare("SELECT value FROM settings WHERE key LIKE ?").get(`plugin:${S3_PLUGIN_ID}:user:%`) as { value: string };
    assert.ok(!row.value.includes(s3.secretAccessKey), "no plain text in the database");
    const stored = JSON.parse(row.value) as { secretEnc: string; accessKeyId: string };
    assert.equal(open(stored.secretEnc, SECRET, "cadence-s3-secret-keys"), s3.secretAccessKey);
    assert.equal(open(stored.secretEnc, "x".repeat(64), "cadence-s3-secret-keys"), null);
    assert.equal(open(stored.secretEnc, SECRET, "cadence-webdav-passwords"), null, "a WebDAV key can't open an S3 secret");
    const status = await app.inject({ method: "GET", url: "/api/s3/status", headers: alice });
    assert.ok(!status.body.includes(s3.secretAccessKey) && !status.body.includes(stored.secretEnc));
    assert.equal((status.json() as { accessKeyId: string }).accessKeyId, s3.accessKeyId);
  } finally {
    await app.close();
    await s3.stop();
  }
});

test("bad keys, a wrong region and a missing bucket are explained without echoing upstream text", async () => {
  const s3 = bucket(await new FakeS3().start());
  const { app, db, alice } = await setup();
  try {
    const wrongSecret = await connect(app, alice, s3, { secretAccessKey: "not-the-secret" });
    assert.equal(wrongSecret.statusCode, 400);
    assert.equal((wrongSecret.json() as { error: string }).error, "s3_bad_credentials");
    const wrongKey = await connect(app, alice, s3, { accessKeyId: "AKIANOTAREALKEY" });
    assert.equal((wrongKey.json() as { error: string }).error, "s3_bad_credentials");
    const region = await connect(app, alice, s3, { region: "eu-west-3" });
    assert.equal((region.json() as { error: string }).error, "s3_wrong_region");
    assert.match((region.json() as { message: string }).message, /us-east-1/);
    const noBucket = await connect(app, alice, s3, { bucket: "nope-bucket" });
    assert.equal((noBucket.json() as { error: string }).error, "s3_no_bucket");
    for (const bad of [{ bucket: "x" }, { accessKeyId: "" }, { secretAccessKey: "" }, { region: "bad region!" }, { folders: ["../x"] }, { pathStyle: "yes" }]) {
      assert.equal((await connect(app, alice, s3, bad)).statusCode, 400, JSON.stringify(bad));
    }
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'plugin:cadence.s3:user:%'"), 0);
  } finally {
    await app.close();
    await s3.stop();
  }
});

test("SSRF: private and metadata endpoints are refused unless the owner allows private networks", async () => {
  const s3 = bucket(await new FakeS3().start());
  const strict = await setup({ env: {}, maxConnectAttempts: 1000 });
  try {
    for (const endpoint of [s3.url, "http://169.254.169.254", "http://localhost:9000", "https://10.0.0.5", "http://example.com:9000"]) {
      const res = await strict.app.inject({ method: "PUT", url: "/api/s3/connection", headers: strict.alice, payload: body(s3, { endpoint }) });
      assert.equal(res.statusCode, 400, endpoint);
      assert.equal((res.json() as { error: string }).error, "address_not_allowed", endpoint);
    }
    assert.equal(s3.calls.length, 0, "the storage server was never contacted");
    assert.equal((await strict.app.inject({ method: "PUT", url: "/api/s3/admin", headers: strict.alice, payload: { allowPrivateNetwork: true } })).statusCode, 403);
    await strict.app.inject({ method: "PUT", url: "/api/s3/admin", headers: strict.admin, payload: { allowPrivateNetwork: true } });
    assert.equal((await connect(strict.app, strict.alice, s3)).statusCode, 200);
  } finally {
    await strict.app.close();
    await s3.stop();
  }
});

test("folders are key prefixes: pick them, index only them, and removal follows", async () => {
  const s3 = bucket(await new FakeS3().start());
  const { app, alice, bob } = await setup();
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/s3/folders", headers: alice })).statusCode, 409);
    await connect(app, alice, s3, { folders: ["Other"] });
    assert.equal((await indexNow(app, alice)).trackCount, 1);

    const top = (await app.inject({ method: "GET", url: "/api/s3/folders", headers: alice })).json() as { folders: { name: string; path: string }[] };
    assert.deepEqual(top.folders.map((f) => f.path), ["Night Owls/", "Other/", "Solo & Friends/"]);
    const inner = (await app.inject({ method: "GET", url: "/api/s3/folders?path=Night%20Owls/", headers: alice })).json() as { folders: { name: string }[] };
    assert.deepEqual(inner.folders.map((f) => f.name), ["After Dark"]);
    assert.equal((await app.inject({ method: "GET", url: "/api/s3/folders?path=a/../../b", headers: alice })).statusCode, 400);

    await app.inject({ method: "PUT", url: "/api/s3/folders", headers: alice, payload: { folders: ["Night Owls/", "Solo & Friends/"] } });
    await new Promise((r) => setTimeout(r, 50));
    const wider = await indexNow(app, alice);
    assert.equal(wider.trackCount, 3);
    assert.deepEqual((await tracks(app, alice)).items.map((t) => t.title).sort(), ["Blue Hour", "Café (live)", "Moth"]);

    s3.objects.delete("Night Owls/After Dark/02 Moth.mp3");
    const after = await indexNow(app, alice);
    assert.equal(after.indexing.removed, 1);
    assert.equal(after.trackCount, 2);
    assert.equal((await tracks(app, bob)).total, 0, "another person sees nothing");
  } finally {
    await app.close();
    await s3.stop();
  }
});

test("a bucket that errors out leaves the cached library alone", async () => {
  const s3 = bucket(await new FakeS3().start());
  const { app, alice } = await setup();
  try {
    await connect(app, alice, s3);
    await indexNow(app, alice);
    s3.secretAccessKey = "rotated-key"; // the provider rotated the key
    const down = await indexNow(app, alice);
    assert.equal(down.indexing.status, "failed");
    assert.equal(down.indexing.error, "auth_failed");
    assert.equal(down.trackCount, 4);
  } finally {
    await app.close();
    await s3.stop();
  }
});

test("works against AWS-style addresses too (virtual-hosted and path-style URL building)", () => {
  const creds = { accessKeyId: "a", secretAccessKey: "b" };
  assert.equal(objectUrl({ region: "eu-west-1", bucket: "my-music", pathStyle: false, credentials: creds }, "A B/c+d.mp3").href, "https://my-music.s3.eu-west-1.amazonaws.com/A%20B/c%2Bd.mp3");
  assert.equal(objectUrl({ region: "eu-west-1", bucket: "my.music", pathStyle: true, credentials: creds }, "x.mp3").href, "https://s3.eu-west-1.amazonaws.com/my.music/x.mp3");
  assert.equal(objectUrl({ endpoint: "https://abc.r2.cloudflarestorage.com", region: "auto", bucket: "m", pathStyle: true, credentials: creds }, "x/y.mp3").href, "https://abc.r2.cloudflarestorage.com/m/x/y.mp3");
  assert.equal(objectUrl({ endpoint: "https://s3.example.com", region: "r", bucket: "m", pathStyle: false, credentials: creds }, "y.mp3").href, "https://m.s3.example.com/y.mp3");
  assert.equal(isPathStyleByDefault(undefined, "plain"), false);
  assert.equal(isPathStyleByDefault(undefined, "has.dots"), true);
  assert.equal(isPathStyleByDefault("https://minio.local", "plain"), true);
  assert.equal(normalizePrefix("/Music//Rock"), "Music/Rock/");
  assert.equal(normalizePrefix(""), "");
  assert.equal(normalizePrefix("a/../b"), null);
});

test("disconnect forgets the key and the cache; streaming links die with it", async () => {
  const s3 = bucket(await new FakeS3().start());
  const { app, db, alice } = await setup();
  try {
    await connect(app, alice, s3);
    await indexNow(app, alice);
    const id = (await tracks(app, alice)).items[0]!.id;
    const link = (await app.inject({ method: "GET", url: `/api/s3/tracks/${id}/stream-url`, headers: alice })).json() as { path: string };
    assert.equal((await app.inject({ method: "DELETE", url: "/api/s3/connection", headers: alice })).statusCode, 204);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM source_tracks WHERE source = 's3'"), 0);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'plugin:cadence.s3:user:%'"), 0);
    assert.equal((await app.inject({ method: "GET", url: "/" + link.path })).statusCode, 404);
  } finally {
    await app.close();
    await s3.stop();
  }
});
