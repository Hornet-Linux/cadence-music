import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { AuthResponse } from "@uma/shared";
import { buildApp } from "../../app.js";
import { createLocalUser } from "../../auth/users.js";
import type { Config } from "../../config.js";
import { openDb, type Db } from "../../db.js";
import { open } from "../../llm/secretBox.js";
import { pruneOrphanedUserConfig } from "../sourcesCommon/orphans.js";
import { playCounts, redact } from "../sourcesCommon/util.js";
import { authQuery } from "./client.js";
import { FakeSubsonic, IDS, PAYLOAD } from "./fakeSubsonic.js";
import { createSubsonicPlugin, type SubsonicPluginOptions } from "./plugin.js";
import type { AdminAddress, AdminTestResult, Page, SubsonicAlbum, SubsonicStatus, SubsonicStreamUrl, SubsonicTrack } from "./types.js";

const SECRET = "s".repeat(64);
const GOOD = { username: "tester", password: "subsonic-test-pass" };

async function setup(opts: { fake?: FakeSubsonic | null; plugin?: SubsonicPluginOptions; extraUsers?: string[]; address?: boolean } = {}) {
  const fake = opts.fake === null ? null : (opts.fake ?? (await new FakeSubsonic().start()));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-sub-"));
  const db = openDb(":memory:");
  await createLocalUser(db, { username: "admin", password: "admin-password", isAdmin: true });
  await createLocalUser(db, { username: "alice", password: "alice-password" });
  await createLocalUser(db, { username: "bob", password: "bob-password" });
  for (const u of opts.extraUsers ?? []) await createLocalUser(db, { username: u, password: `${u}-password` });
  const config: Config = { host: "127.0.0.1", port: 0, dataDir: dir, musicDir: dir, scanIntervalMinutes: 0, trustProxy: false, logLevel: "silent" };
  const app = await buildApp({ config, db, secret: SECRET, logger: false, plugins: [createSubsonicPlugin({ envUrl: "", ...opts.plugin })] });
  const signIn = async (username: string) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: `${username}-password` } });
    return { authorization: `Bearer ${(res.json() as AuthResponse).token}` };
  };
  const admin = await signIn("admin");
  if (fake && opts.address !== false) {
    await app.inject({ method: "PUT", url: "/api/admin/subsonic", headers: admin, payload: { serverUrl: fake.url } });
  }
  const connect = async (headers: { authorization: string }, body: object = GOOD) =>
    app.inject({ method: "PUT", url: "/api/subsonic/connection", headers, payload: body });
  return { app, db, fake: fake as FakeSubsonic, admin, alice: await signIn("alice"), bob: await signIn("bob"), signIn, connect };
}
type T = Awaited<ReturnType<typeof setup>>;

const get = (t: T, url: string, who: { authorization: string }) => t.app.inject({ method: "GET", url, headers: who });
const page = <X>(res: { json: () => unknown }) => res.json() as Page<X>;

async function streamPath(t: T, id: string, who: { authorization: string }): Promise<string> {
  const res = await get(t, `/api/subsonic/tracks/${id}/stream-url`, who);
  assert.equal(res.statusCode, 200, res.body);
  return `/${(res.json() as SubsonicStreamUrl).path}`;
}

async function finish(t: T) {
  await t.app.close();
  await t.fake?.stop();
}

function storedRows(db: Db): { key: string; value: string }[] {
  return db.prepare("SELECT key, value FROM settings WHERE key LIKE 'plugin:cadence.subsonic:user:%' ORDER BY key").all() as { key: string; value: string }[];
}

function userId(db: Db, name: string): number {
  return (db.prepare("SELECT id FROM users WHERE username = ?").get(name) as { id: number }).id;
}

function storedPassword(db: Db, name: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(`plugin:cadence.subsonic:user:${userId(db, name)}`) as { value: string } | undefined;
  const enc = row && (JSON.parse(row.value) as { passwordEnc?: string }).passwordEnc;
  return enc ? (open(enc, SECRET, "subsonic-passwords") ?? undefined) : undefined;
}

// ---- helpers under test ---------------------------------------------------------

test("token auth is md5(password + salt) with a fresh salt, and the legacy form hex-encodes the password", () => {
  const q = authQuery({ baseUrl: "http://x", username: "u", password: "sesame" }, "c19b2d");
  assert.equal(q.t, createHash("md5").update("sesamec19b2d").digest("hex"));
  assert.equal(q.t, "26719a1196d2a940705a59634eb18eab");
  assert.equal(q.s, "c19b2d");
  assert.equal(q.p, undefined, "the password itself is never sent with token auth");
  assert.notEqual(authQuery({ baseUrl: "http://x", username: "u", password: "sesame" }).s, authQuery({ baseUrl: "http://x", username: "u", password: "sesame" }).s);
  const legacy = authQuery({ baseUrl: "http://x", username: "u", password: "sesame", legacy: true });
  assert.equal(legacy.p, `enc:${Buffer.from("sesame").toString("hex")}`);
  assert.equal(legacy.t, undefined);
  assert.equal(authQuery({ baseUrl: "http://x" }).u, undefined, "no credentials, no user");
});

test("a play counts after half the track or four minutes, never for very short tracks", () => {
  assert.equal(playCounts(100, 200), true);
  assert.equal(playCounts(99, 200), false);
  assert.equal(playCounts(240, 1000), true);
  assert.equal(playCounts(239, 1000), false);
  assert.equal(playCounts(20, 25), false);
  assert.equal(playCounts(250, undefined), true);
  assert.equal(playCounts(10, undefined), false);
});

test("redact removes credentials from text meant for logs", () => {
  const url = "http://x/rest/ping.view?u=bob&t=abc123&s=salt99&v=1.16.1&c=Cadence";
  const out = redact(url);
  assert.ok(!out.includes("abc123") && !out.includes("salt99") && !out.includes("bob"));
  assert.match(out, /v=1\.16\.1/);
  assert.ok(!redact("X-Plex-Token: sekrit").includes("sekrit"));
  assert.ok(!redact("?X-Plex-Token=sekrit&a=1").includes("sekrit"));
});

// ---- sign-in -------------------------------------------------------------------

test("sign-in: token auth, password encrypted at rest, never returned, failures are 422 not 401", async () => {
  const t = await setup();
  assert.deepEqual((await get(t, "/api/subsonic/status", t.alice)).json(), { configured: true, connected: false });

  const bad = await t.connect(t.alice, { username: "tester", password: "wrong-password" });
  // A 401 would make the Cadence app sign the person out of Cadence itself.
  assert.equal(bad.statusCode, 422);
  assert.equal(bad.json().error, "subsonic_invalid_credentials");
  assert.ok(!bad.body.includes("Wrong username"), "no upstream text");
  assert.equal(storedRows(t.db).length, 0);

  const ok = await t.connect(t.alice);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json() as SubsonicStatus, { configured: true, connected: true, serverName: "Fakesonic 0.1.0", userName: "tester" });
  assert.ok(!ok.body.includes(GOOD.password));
  assert.ok(!(await get(t, "/api/subsonic/status", t.alice)).body.includes(GOOD.password));

  const dump = JSON.stringify(storedRows(t.db));
  assert.ok(!dump.includes(GOOD.password), "password is encrypted at rest");
  assert.equal(storedPassword(t.db, "alice"), GOOD.password);
  const sealed = (JSON.parse(storedRows(t.db)[0].value) as { passwordEnc: string }).passwordEnc;
  assert.equal(open(sealed, SECRET), null, "not readable as an AI provider key");
  assert.equal(open(sealed, "x".repeat(64), "subsonic-passwords"), null, "not readable with another server secret");

  // The call used token auth, and says who it is.
  const login = t.fake.callsTo("ping").at(-1)!;
  assert.equal(login.query.u, "tester");
  assert.equal(login.query.t, createHash("md5").update(GOOD.password + login.query.s).digest("hex"));
  assert.equal(login.query.p, undefined);
  assert.equal(login.query.c, "Cadence");
  assert.equal(login.query.f, "json");
  assert.match(String(login.headers["user-agent"]), /^Cadence-Server\//);

  // Disconnecting forgets everything.
  assert.equal((await t.app.inject({ method: "DELETE", url: "/api/subsonic/connection", headers: t.alice })).statusCode, 204);
  assert.deepEqual((await get(t, "/api/subsonic/status", t.alice)).json(), { configured: true, connected: false });
  assert.equal(storedRows(t.db).length, 0);
  assert.equal((await get(t, "/api/subsonic/tracks", t.alice)).json().error, "subsonic_not_connected");
  await finish(t);
});

test("sign-in: a server that cannot do token auth (code 41) gets the older password parameter", async () => {
  const fake = await new FakeSubsonic().start();
  fake.ldap = true;
  const t = await setup({ fake });
  assert.equal((await t.connect(t.alice)).statusCode, 200);
  const calls = t.fake.callsTo("ping");
  assert.equal(calls.length, 2);
  assert.ok(calls[0].query.t && !calls[0].query.p);
  assert.equal(calls[1].query.p, `enc:${Buffer.from(GOOD.password).toString("hex")}`);
  // Later calls keep using the form that works.
  assert.equal((await get(t, "/api/subsonic/playlists", t.alice)).statusCode, 200);
  assert.ok(t.fake.callsTo("getPlaylists")[0].query.p?.startsWith("enc:"));
  assert.equal(t.fake.callsTo("getPlaylists")[0].query.t, undefined);
  await finish(t);
});

test("sign-in: unreachable server is a generic 502; not configured is 409", async () => {
  const t = await setup({ fake: null });
  assert.deepEqual((await get(t, "/api/subsonic/status", t.alice)).json(), { configured: false, connected: false });
  assert.equal((await t.connect(t.alice)).json().error, "subsonic_not_configured");

  const dead = await new FakeSubsonic().start();
  const deadUrl = dead.url;
  await dead.stop();
  await t.app.inject({ method: "PUT", url: "/api/admin/subsonic", headers: t.admin, payload: { serverUrl: deadUrl } });
  const res = await t.connect(t.alice);
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, "subsonic_failed");
  assert.ok(!res.body.includes("127.0.0.1") && !res.body.includes("ECONNREFUSED"), "no network details");
  await t.app.close();
});

test("sign-in rejects malformed bodies", async () => {
  const t = await setup();
  for (const body of [{}, { username: "", password: "x" }, { username: "tester" }, { username: 5, password: "x" }, { username: "tester", password: 7 }, { username: "tester", password: "" }, { username: "x".repeat(300), password: "x" }]) {
    assert.equal((await t.connect(t.alice, body)).statusCode, 400, JSON.stringify(body));
  }
  assert.equal(t.fake.callsTo("ping").length, 0);
  await finish(t);
});

test("every route needs a signed-in Cadence user (except the signed stream and image URLs)", async () => {
  const t = await setup();
  const routes: [string, string][] = [
    ["GET", "/api/subsonic/status"],
    ["PUT", "/api/subsonic/connection"],
    ["DELETE", "/api/subsonic/connection"],
    ["GET", "/api/subsonic/tracks"],
    ["GET", "/api/subsonic/albums"],
    ["GET", "/api/subsonic/artists"],
    ["GET", "/api/subsonic/albums/al1/tracks"],
    ["GET", "/api/subsonic/playlists"],
    ["GET", "/api/subsonic/playlists/p1/tracks"],
    ["PUT", "/api/subsonic/favourites/s1"],
    ["DELETE", "/api/subsonic/favourites/s1"],
    ["GET", "/api/subsonic/tracks/s1/stream-url"],
    ["POST", "/api/subsonic/playback"],
    ["GET", "/api/admin/subsonic"],
    ["PUT", "/api/admin/subsonic"],
    ["POST", "/api/admin/subsonic/test"],
  ];
  for (const [method, url] of routes) {
    assert.equal((await t.app.inject({ method: method as "GET", url })).statusCode, 401, `${method} ${url}`);
  }
  for (const [method, url] of routes.filter(([, u]) => u.startsWith("/api/admin"))) {
    assert.equal((await t.app.inject({ method: method as "GET", url, headers: t.alice, payload: {} })).statusCode, 403, `${method} ${url}`);
  }
  assert.equal(t.fake.calls.length, 0);
  await finish(t);
});

// ---- per-user isolation ------------------------------------------------------------

test("people cannot point the server anywhere: the address is the owner's alone", async () => {
  const t = await setup();
  const evil = await new FakeSubsonic().start();
  const smuggled = { ...GOOD, serverUrl: evil.url, url: evil.url, baseUrl: evil.url, host: evil.url };
  assert.equal((await t.connect(t.alice, smuggled)).statusCode, 200);
  assert.equal((await get(t, `/api/subsonic/tracks?serverUrl=${encodeURIComponent(evil.url)}&url=${encodeURIComponent(evil.url)}`, t.alice)).statusCode, 200);
  const res = await t.app.inject({
    method: "GET",
    url: "/api/subsonic/albums",
    headers: { ...t.alice, host: new URL(evil.url).host, "x-forwarded-host": new URL(evil.url).host, "x-subsonic-url": evil.url },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(evil.calls.length, 0, "nothing a person sends is used as an address");
  assert.ok(t.fake.calls.length > 0);
  await evil.stop();
  await finish(t);
});

test("per-user isolation: separate Subsonic accounts, stars and stored sign-ins", async () => {
  const t = await setup();
  assert.equal((await t.connect(t.alice)).statusCode, 200);
  assert.equal((await t.connect(t.bob, { username: "other", password: "other-pass" })).statusCode, 200);
  assert.equal(storedPassword(t.db, "alice"), "subsonic-test-pass");
  assert.equal(storedPassword(t.db, "bob"), "other-pass");
  assert.equal(storedRows(t.db).length, 2);

  // Alice stars a song; Bob's starred list (a different Subsonic account) stays empty.
  assert.equal((await t.app.inject({ method: "PUT", url: "/api/subsonic/favourites/s1", headers: t.alice })).statusCode, 204);
  assert.deepEqual(page<SubsonicTrack>(await get(t, "/api/subsonic/tracks?favourites=1", t.alice)).items.map((x) => x.id), ["s1"]);
  assert.deepEqual(page<SubsonicTrack>(await get(t, "/api/subsonic/tracks?favourites=1", t.bob)).items, []);
  assert.equal(t.fake.callsTo("star")[0].query.u, "tester");

  // Bob's calls use Bob's login and nothing of Alice's leaks into his responses.
  const bobs = await get(t, "/api/subsonic/tracks", t.bob);
  assert.equal(t.fake.callsTo("search3").at(-1)!.query.u, "other");
  assert.ok(!bobs.body.includes("subsonic-test-pass") && !bobs.body.includes("tester"));
  // Status never shows another person's account.
  assert.equal((await get(t, "/api/subsonic/status", t.bob)).json().userName, "other");

  // Alice's stream link does not work as Bob (the signature binds the person).
  const aliceUrl = await streamPath(t, IDS.dance, t.alice);
  const bobId = userId(t.db, "bob");
  const asBob = aliceUrl.replace(/u=\d+/, `u=${bobId}`);
  assert.equal((await t.app.inject({ method: "GET", url: asBob })).statusCode, 403);

  // Disconnecting one person leaves the other connected.
  await t.app.inject({ method: "DELETE", url: "/api/subsonic/connection", headers: t.bob });
  assert.equal((await t.app.inject({ method: "GET", url: aliceUrl })).statusCode, 200);
  assert.equal(storedRows(t.db).length, 1);
  await finish(t);
});

test("stored sign-ins of people who were deleted are swept up", async () => {
  const t = await setup();
  await t.connect(t.alice);
  await t.connect(t.bob, { username: "other", password: "other-pass" });
  t.db.prepare("DELETE FROM users WHERE username = 'alice'").run();
  assert.equal(pruneOrphanedUserConfig(t.db, "cadence.subsonic"), 1);
  assert.equal(storedRows(t.db).length, 1);
  assert.equal(storedPassword(t.db, "bob"), "other-pass");
  assert.equal(pruneOrphanedUserConfig(t.db, "cadence.subsonic"), 0);
  await finish(t);
});
// ---- browsing -------------------------------------------------------------------

test("tracks, albums, artists and playlists are mapped, with signed relative artwork paths", async () => {
  const t = await setup();
  await t.connect(t.alice);

  const all = page<SubsonicTrack>(await get(t, "/api/subsonic/tracks", t.alice));
  assert.equal(all.items.length, 6);
  const first = all.items.find((x) => x.id === "s1")!;
  assert.deepEqual(
    { ...first, artwork: undefined },
    { id: "s1", title: "One More Time", artists: ["Daft Punk"], album: "Discovery", albumId: "al1", artistId: "ar1", durationSec: 200, trackNo: 1, year: 2001, genre: "Electronic", favourite: false, playCount: 0, artwork: undefined },
  );
  assert.match(first.artwork!, /^api\/subsonic\/image\/al1\?u=\d+&exp=\d+&sig=[\w-]+$/);
  assert.ok(!all.items.some((x) => JSON.stringify(x).includes("http")), "no absolute URLs");
  // An empty query lists the library (what Navidrome, Gonic and Airsonic answer to an empty search3).
  assert.equal(t.fake.callsTo("search3")[0].query.query, "");

  const albums = page<SubsonicAlbum>(await get(t, "/api/subsonic/albums", t.alice));
  assert.deepEqual(albums.items.map((a) => a.name), ["Cross", "Discovery", "Nothing", "Random Access Memories"]);
  assert.deepEqual(albums.items[1], { id: "al1", name: "Discovery", artist: "Daft Punk", artistId: "ar1", year: 2001, trackCount: 1, artwork: albums.items[1].artwork });
  assert.equal(albums.hasMore, false);

  const byArtist = page<SubsonicAlbum>(await get(t, "/api/subsonic/albums?artistId=ar1", t.alice));
  assert.deepEqual(byArtist.items.map((a) => a.id), ["al1", "al3"]);
  const searched = page<SubsonicAlbum>(await get(t, "/api/subsonic/albums?q=cross", t.alice));
  assert.deepEqual(searched.items.map((a) => a.id), ["al2"]);

  const albumTracks = page<SubsonicTrack>(await get(t, "/api/subsonic/albums/al3/tracks", t.alice));
  assert.deepEqual(albumTracks.items.map((x) => x.id), ["s3", "s4"]);

  const artists = page<{ id: string; name: string; albumCount?: number }>(await get(t, "/api/subsonic/artists", t.alice));
  assert.deepEqual(artists.items.map((x) => [x.name, x.albumCount]), [["Daft Punk", 2], ["Justice", 1], ["Nobody", 1]]);
  assert.deepEqual(page<{ name: string }>(await get(t, "/api/subsonic/artists?q=jus", t.alice)).items.map((x) => x.name), ["Justice"]);
  assert.equal(page<{ name: string }>(await get(t, "/api/subsonic/artists?limit=1&offset=1", t.alice)).items[0].name, "Justice");

  const playlists = (await get(t, "/api/subsonic/playlists", t.alice)).json() as { items: { id: string; name: string; trackCount: number }[] };
  assert.deepEqual(playlists.items.map((p) => [p.id, p.name, p.trackCount]), [["p1", "Night drive", 2]]);
  assert.deepEqual(page<SubsonicTrack>(await get(t, "/api/subsonic/playlists/p1/tracks", t.alice)).items.map((x) => x.id), ["s1", "s2"]);
  await finish(t);
});

test("paging: limits are clamped, hasMore follows full pages", async () => {
  const t = await setup();
  await t.connect(t.alice);
  const two = page<SubsonicTrack>(await get(t, "/api/subsonic/tracks?limit=2", t.alice));
  assert.equal(two.items.length, 2);
  assert.equal(two.hasMore, true);
  const rest = page<SubsonicTrack>(await get(t, "/api/subsonic/tracks?limit=4&offset=2", t.alice));
  assert.equal(rest.items.length, 4);
  assert.equal(t.fake.callsTo("search3").at(-1)!.query.songOffset, "2");
  const last = page<SubsonicTrack>(await get(t, "/api/subsonic/tracks?limit=50&offset=4", t.alice));
  assert.equal(last.hasMore, false);
  await get(t, "/api/subsonic/tracks?limit=99999", t.alice);
  assert.equal(t.fake.callsTo("search3").at(-1)!.query.songCount, "500");
  await get(t, "/api/subsonic/tracks?limit=banana&offset=-5", t.alice);
  assert.equal(t.fake.callsTo("search3").at(-1)!.query.songCount, "100");
  assert.equal(t.fake.callsTo("search3").at(-1)!.query.songOffset, "0");
  const albums = page<SubsonicAlbum>(await get(t, "/api/subsonic/albums?limit=2", t.alice));
  assert.equal(albums.hasMore, true);
  // sort is a whitelist
  await get(t, "/api/subsonic/albums?sort=newest", t.alice);
  assert.equal(t.fake.callsTo("getAlbumList2").at(-1)!.query.type, "newest");
  await get(t, "/api/subsonic/albums?sort=../../etc", t.alice);
  assert.equal(t.fake.callsTo("getAlbumList2").at(-1)!.query.type, "alphabeticalByName");
  await finish(t);
});

test("a server that lists nothing for an empty search still shows the first albums' tracks", async () => {
  const fake = await new FakeSubsonic().start();
  fake.emptyQueryEmpty = true;
  const t = await setup({ fake });
  await t.connect(t.alice);
  const all = page<SubsonicTrack>(await get(t, "/api/subsonic/tracks", t.alice));
  assert.equal(all.items.length, 6);
  assert.equal(all.hasMore, false);
  await finish(t);
});

test("a text search also finds tracks by artist and by album, titles first, without repeats", async () => {
  const t = await setup();
  await t.connect(t.alice);
  // "daft" matches no title; it matches the artist, so their tracks appear.
  const byArtist = page<SubsonicTrack>(await get(t, "/api/subsonic/tracks?q=daft", t.alice));
  assert.deepEqual(byArtist.items.map((x) => x.id).sort(), ["s1", "s3", "s4"]);
  // "random" matches an album.
  const byAlbum = page<SubsonicTrack>(await get(t, "/api/subsonic/tracks?q=random", t.alice));
  assert.deepEqual(byAlbum.items.map((x) => x.id).sort(), ["s3", "s4"]);
  // A title match comes first and is not repeated by its album.
  const title = page<SubsonicTrack>(await get(t, "/api/subsonic/tracks?q=get%20lucky", t.alice));
  assert.deepEqual(title.items.map((x) => x.id), ["s3"]);
  const both = page<SubsonicTrack>(await get(t, "/api/subsonic/tracks?q=d", t.alice));
  assert.equal(new Set(both.items.map((x) => x.id)).size, both.items.length);
  assert.equal(page<SubsonicTrack>(await get(t, "/api/subsonic/tracks?q=zzzz", t.alice)).items.length, 0);
  await finish(t);
});

test("ids that go into Subsonic requests must be plain identifiers", async () => {
  const t = await setup();
  await t.connect(t.alice);
  const before = t.fake.calls.length;
  for (const bad of ["a%20b", "a%26id%3D1", "..%2F..", "a%3Bb", "%00", "x".repeat(200)]) {
    for (const url of [`/api/subsonic/albums/${bad}/tracks`, `/api/subsonic/playlists/${bad}/tracks`, `/api/subsonic/tracks/${bad}/stream-url`, `/api/subsonic/stream/${bad}`, `/api/subsonic/image/${bad}`]) {
      const res = await get(t, url, t.alice);
      assert.ok(res.statusCode >= 400 && res.statusCode < 500, `${url} -> ${res.statusCode}`);
    }
    assert.equal((await t.app.inject({ method: "PUT", url: `/api/subsonic/favourites/${bad}`, headers: t.alice })).statusCode === 204, false);
  }
  assert.equal((await get(t, "/api/subsonic/tracks?albumId=a%26b", t.alice)).statusCode, 400);
  assert.equal((await get(t, "/api/subsonic/albums?artistId=a%26b", t.alice)).statusCode, 400);
  assert.equal(t.fake.calls.length, before, "nothing was sent upstream");
  await finish(t);
});

test("favourites: star and unstar in the person's own Subsonic account", async () => {
  const t = await setup();
  await t.connect(t.alice);
  assert.equal((await t.app.inject({ method: "PUT", url: `/api/subsonic/favourites/${IDS.dance}`, headers: t.alice })).statusCode, 204);
  assert.deepEqual(t.fake.stars.get("tester"), new Set([IDS.dance]));
  const tracks = page<SubsonicTrack>(await get(t, "/api/subsonic/tracks", t.alice));
  assert.equal(tracks.items.find((x) => x.id === IDS.dance)!.favourite, true);
  assert.equal(tracks.items.find((x) => x.id === IDS.oneMoreTime)!.favourite, false);
  const starred = page<SubsonicTrack>(await get(t, "/api/subsonic/tracks?favourites=1&q=justice", t.alice));
  assert.deepEqual(starred.items.map((x) => x.id), [IDS.dance]);
  assert.equal((await t.app.inject({ method: "DELETE", url: `/api/subsonic/favourites/${IDS.dance}`, headers: t.alice })).statusCode, 204);
  assert.equal(t.fake.stars.get("tester")!.size, 0);
  assert.equal((await t.app.inject({ method: "PUT", url: "/api/subsonic/favourites/nope", headers: t.alice })).statusCode, 404);
  await finish(t);
});

test("playback reports become now-playing and scrobbles, counting only real listens", async () => {
  const t = await setup();
  await t.connect(t.alice);
  const post = (payload: object) => t.app.inject({ method: "POST", url: "/api/subsonic/playback", headers: t.alice, payload });
  assert.equal((await post({ event: "start", itemId: IDS.dance, positionSec: 0 })).statusCode, 204);
  assert.deepEqual(t.fake.nowPlaying, [IDS.dance]);
  assert.equal(t.fake.callsTo("scrobble")[0].query.submission, "false");
  // Skipped after 10 seconds of a 200 second song: no play.
  await post({ event: "stop", itemId: IDS.dance, positionSec: 10, durationSec: 200 });
  assert.equal(t.fake.plays.get(IDS.dance) ?? 0, 0);
  // Heard most of it: a play, stamped with when it started.
  const before = Date.now();
  await post({ event: "stop", itemId: IDS.dance, positionSec: 150, durationSec: 200 });
  assert.equal(t.fake.plays.get(IDS.dance), 1);
  const sub = t.fake.callsTo("scrobble").at(-1)!.query;
  assert.equal(sub.submission, "true");
  assert.ok(Math.abs(Number(sub.time) - (before - 150_000)) < 5000);
  for (const bad of [{}, { event: "pause", itemId: "s1", positionSec: 1 }, { event: "stop", itemId: "a b", positionSec: 1 }, { event: "stop", itemId: "s1", positionSec: -1 }, { event: "stop", itemId: "s1", positionSec: "9" }, { event: "stop", itemId: "s1", positionSec: 1, durationSec: "x" }]) {
    assert.equal((await post(bad)).statusCode, 400, JSON.stringify(bad));
  }
  // Failing to report is not an error for the app.
  t.fake.failWith = "boom";
  assert.equal((await post({ event: "start", itemId: IDS.dance, positionSec: 0 })).statusCode, 204);
  await finish(t);
});

// ---- failures -----------------------------------------------------------------------

test("a rejected sign-in drops the stale connection and asks the person to sign in again (409, never 401)", async () => {
  const t = await setup();
  await t.connect(t.alice);
  t.fake.users.tester = "changed-password";
  const res = await get(t, "/api/subsonic/tracks", t.alice);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "subsonic_session_expired");
  assert.deepEqual((await get(t, "/api/subsonic/status", t.alice)).json(), { configured: true, connected: false });
  assert.equal(storedRows(t.db).length, 0);
  await finish(t);
});

test("clients never see upstream text or network details", async () => {
  const t = await setup();
  await t.connect(t.alice);
  t.fake.failWith = "stack trace at /srv/secret/path password=hunter2";
  const res = await get(t, "/api/subsonic/tracks", t.alice);
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, "subsonic_failed");
  assert.ok(!res.body.includes("hunter2") && !res.body.includes("/srv") && !res.body.includes("127.0.0.1"));
  await finish(t);
});

test("redirects to another address are not followed (the credentials would go with them)", async () => {
  const t = await setup();
  await t.connect(t.alice);
  const elsewhere = await new FakeSubsonic().start();
  t.fake.redirectTo = elsewhere.url;
  const res = await get(t, "/api/subsonic/tracks", t.alice);
  assert.equal(res.statusCode, 502);
  assert.ok(res.json().message.includes("couldn't be reached"));
  assert.equal(elsewhere.calls.length, 0, "no credentials went to the redirect target");
  await elsewhere.stop();
  await finish(t);
});

test("an oversized answer is refused, not buffered", async () => {
  const fake = await new FakeSubsonic().start();
  const t = await setup({ fake });
  await t.connect(t.alice);
  fake.huge = true;
  const res = await get(t, "/api/subsonic/tracks?q=x", t.alice);
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().message, "Subsonic sent more than Cadence accepts");
  await finish(t);
});
// ---- streaming ----------------------------------------------------------------------

test("stream: signed URL, whole file and ranges are passed through; the original is asked for when browsers can play it", async () => {
  const t = await setup();
  await t.connect(t.alice);
  const url = await streamPath(t, IDS.dance, t.alice);
  assert.match(url, new RegExp(`^/api/subsonic/stream/${IDS.dance}\\?u=\\d+&exp=\\d+&sig=`));
  const { expiresAt } = (await get(t, `/api/subsonic/tracks/${IDS.dance}/stream-url`, t.alice)).json() as SubsonicStreamUrl;
  assert.ok(Math.abs(expiresAt - (Date.now() / 1000 + 6 * 3600)) < 30, "six hours");

  // No bearer header: the signature is the credential.
  const whole = await t.app.inject({ method: "GET", url });
  assert.equal(whole.statusCode, 200);
  assert.equal(whole.headers["content-type"], "audio/mpeg");
  assert.equal(whole.headers["content-length"], String(PAYLOAD.length));
  assert.equal(whole.headers["accept-ranges"], "bytes");
  assert.deepEqual(whole.rawPayload, PAYLOAD);

  const part = await t.app.inject({ method: "GET", url, headers: { range: "bytes=100-199" } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers["content-range"], `bytes 100-199/${PAYLOAD.length}`);
  assert.equal(part.headers["content-length"], "100");
  assert.deepEqual(part.rawPayload, PAYLOAD.subarray(100, 200));
  const tail = await t.app.inject({ method: "GET", url, headers: { range: "bytes=1990-" } });
  assert.equal(tail.statusCode, 206);
  assert.equal(tail.rawPayload.length, 10);
  const suffix = await t.app.inject({ method: "GET", url, headers: { range: "bytes=-5" } });
  assert.deepEqual(suffix.rawPayload, PAYLOAD.subarray(PAYLOAD.length - 5));
  const past = await t.app.inject({ method: "GET", url, headers: { range: "bytes=5000-6000" } });
  assert.equal(past.statusCode, 416);
  assert.equal(past.headers["content-range"], `bytes */${PAYLOAD.length}`);
  // Anything that isn't a single plain range is ignored rather than forwarded.
  const odd = await t.app.inject({ method: "GET", url, headers: { range: "bytes=0-1,5-9" } });
  assert.equal(odd.statusCode, 200);
  assert.equal(t.fake.callsTo("stream").at(-1)!.headers.range, undefined);

  const upstream = t.fake.callsTo("stream")[0];
  assert.equal(upstream.query.format, "raw");
  assert.equal(upstream.query.id, IDS.dance);
  assert.equal(upstream.query.u, "tester");
  assert.ok(upstream.query.t && upstream.query.s);
  assert.equal(upstream.headers["accept-encoding"], "identity");
  assert.equal(t.fake.callsTo("getSong").length, 1, "the file type is looked up once, not for every range request");
  await finish(t);
});

test("stream: formats browsers cannot play are transcoded to MP3 by the server", async () => {
  const t = await setup();
  await t.connect(t.alice);
  const res = await t.app.inject({ method: "GET", url: await streamPath(t, IDS.oggSong, t.alice) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "audio/mpeg");
  const upstream = t.fake.callsTo("stream")[0];
  assert.equal(upstream.query.format, "mp3");
  assert.equal(upstream.query.maxBitRate, "320");
  assert.equal(upstream.query.estimateContentLength, "true");
  const m4a = await t.app.inject({ method: "GET", url: await streamPath(t, IDS.getLucky, t.alice) });
  assert.equal(m4a.headers["content-type"], "audio/mp4");
  assert.equal(t.fake.callsTo("stream")[1].query.format, "raw");
  await finish(t);
});

test("cover art is proxied with a size, and only as an image", async () => {
  const t = await setup();
  await t.connect(t.alice);
  const tracks = page<SubsonicTrack>(await get(t, "/api/subsonic/tracks", t.alice));
  const art = `/${tracks.items[0].artwork}`;
  const res = await t.app.inject({ method: "GET", url: art });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/jpeg");
  assert.deepEqual([...res.rawPayload], [0xff, 0xd8, 0xff, 0xd9]);
  assert.equal(t.fake.callsTo("getCoverArt")[0].query.size, "300");
  await t.app.inject({ method: "GET", url: `${art}&w=99999` });
  assert.equal(t.fake.callsTo("getCoverArt")[1].query.size, "1200");
  await t.app.inject({ method: "GET", url: `${art}&w=abc` });
  assert.equal(t.fake.callsTo("getCoverArt")[2].query.size, "300");
  await finish(t);
});

test("stream and image URLs: bad, expired, other-user and cross-kind signatures are refused", async () => {
  const t = await setup();
  await t.connect(t.alice);
  const url = await streamPath(t, IDS.dance, t.alice);
  const bump = (s: string) => s.slice(0, -2) + (s.endsWith("aa") ? "bb" : "aa");
  const calls = t.fake.calls.length;
  assert.equal((await t.app.inject({ method: "GET", url: bump(url) })).statusCode, 403, "tampered signature");
  assert.equal((await t.app.inject({ method: "GET", url: url.replace(/sig=[^&]+/, "") })).statusCode, 403, "missing signature");
  assert.equal((await t.app.inject({ method: "GET", url: url.replace(/exp=\d+/, "exp=1") })).statusCode, 403, "expired or altered expiry");
  assert.equal((await t.app.inject({ method: "GET", url: url.replace(IDS.dance, IDS.oneMoreTime) })).statusCode, 403, "different item");
  assert.equal((await t.app.inject({ method: "GET", url: url.replace("/stream/", "/image/") })).statusCode, 403, "a stream link is not an image link");
  const tracks = page<SubsonicTrack>(await get(t, "/api/subsonic/tracks", t.alice));
  const art = `/${tracks.items[0].artwork}`;
  assert.equal((await t.app.inject({ method: "GET", url: art.replace("/image/", "/stream/") })).statusCode, 403, "an image link is not a stream link");
  assert.equal((await t.app.inject({ method: "GET", url: `${url}&u=1` })).statusCode, 403, "extra parameters change nothing, but a duplicate u does not pass");
  assert.equal(t.fake.callsTo("stream").length, 0);
  assert.ok(t.fake.calls.length >= calls);
  // A link signed for one service is not valid for another path of the same name.
  assert.equal((await t.app.inject({ method: "GET", url: url.replace("/api/subsonic/", "/api/plex/") })).statusCode, 404);
  await finish(t);
});

test("stream-url: unknown tracks are 404; a person without a sign-in gets nothing", async () => {
  const t = await setup();
  await t.connect(t.alice);
  assert.equal((await get(t, `/api/subsonic/tracks/${IDS.gone}/stream-url`, t.alice)).statusCode, 404);
  assert.equal((await get(t, `/api/subsonic/tracks/${IDS.dance}/stream-url`, t.bob)).json().error, "subsonic_not_connected");
  // A link made for Alice stops working when she signs out, and does not fall back to anyone else's sign-in.
  const url = await streamPath(t, IDS.dance, t.alice);
  await t.connect(t.bob, { username: "other", password: "other-pass" });
  await t.app.inject({ method: "DELETE", url: "/api/subsonic/connection", headers: t.alice });
  assert.equal((await t.app.inject({ method: "GET", url })).statusCode, 409);
  assert.equal(t.fake.callsTo("stream").length, 0);
  await finish(t);
});

test("stream: an error answered with a 200 and an error body is mapped, not played", async () => {
  const t = await setup();
  await t.connect(t.alice);
  const url = await streamPath(t, IDS.dance, t.alice);
  t.fake.errorBodyFor = "not-found";
  assert.equal((await t.app.inject({ method: "GET", url })).statusCode, 404);
  t.fake.errorBodyFor = "wrong-login";
  const res = await t.app.inject({ method: "GET", url });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "subsonic_session_expired");
  assert.equal(storedRows(t.db).length, 0, "the dead sign-in is dropped");
  await finish(t);
});

async function listen(t: T): Promise<string> {
  await t.app.listen({ port: 0, host: "127.0.0.1" });
  return `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
}

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return check();
};

test("stream: when the client goes away the request to Subsonic is cancelled", async () => {
  const t = await setup();
  await t.connect(t.alice);
  const base = await listen(t);
  const url = `${base}${await streamPath(t, IDS.endless, t.alice)}`;
  const got = await new Promise<number>((resolve, reject) => {
    const req = http.get(url, (res) => {
      let bytes = 0;
      res.on("data", (c: Buffer) => {
        bytes += c.length;
        if (bytes > 100_000) {
          req.destroy();
          resolve(bytes);
        }
      });
    });
    req.on("error", () => undefined);
    setTimeout(() => reject(new Error("no data")), 4000).unref();
  });
  assert.ok(got > 100_000);
  assert.ok(await until(() => t.fake.aborted.includes(IDS.endless)), "Subsonic saw the request end");
  await finish(t);
});

test("stream: a server that stops sending is cut off", async () => {
  const t = await setup({ plugin: { streamIdleMs: 150 } });
  await t.connect(t.alice);
  const base = await listen(t);
  const url = `${base}${await streamPath(t, IDS.stall, t.alice)}`;
  const outcome = await new Promise<string>((resolve) => {
    const req = http.get(url, (res) => {
      res.on("data", () => undefined);
      res.on("end", () => resolve("ended"));
      res.on("error", () => resolve("error"));
      res.on("aborted", () => resolve("aborted"));
    });
    req.on("error", () => resolve("error"));
    setTimeout(() => resolve("hung"), 4000).unref();
  });
  assert.notEqual(outcome, "hung");
  assert.ok(await until(() => t.fake.aborted.includes(IDS.stall)), "upstream was cancelled too");
  await finish(t);
});

test("stream: an upstream that never answers its headers times out", async () => {
  const hang = http.createServer((req, res) => {
    // Answers the sign-in and file-type lookups, then goes quiet for the audio itself.
    if (req.url?.includes("/rest/stream")) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ "subsonic-response": { status: "ok", version: "1.16.1", song: { id: "s1", suffix: "flac", title: "x" } } }));
  });
  await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
  const hangUrl = `http://127.0.0.1:${(hang.address() as AddressInfo).port}`;
  const t = await setup({ fake: null, address: false, plugin: { streamHeaderTimeoutMs: 150 } });
  await t.app.inject({ method: "PUT", url: "/api/admin/subsonic", headers: t.admin, payload: { serverUrl: hangUrl } });
  assert.equal((await t.connect(t.alice)).statusCode, 200);
  const res = await t.app.inject({ method: "GET", url: await streamPath(t, "s1", t.alice) });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().message, "Subsonic took too long to answer");
  hang.closeAllConnections();
  hang.close();
  await t.app.close();
});

// ---- rate limits ----------------------------------------------------------------------

test("sign-in attempts are limited per person, so Cadence can't be used to guess Subsonic passwords", async () => {
  const t = await setup();
  const wrong = { username: "tester", password: "guess" };
  for (let i = 0; i < 5; i++) assert.equal((await t.connect(t.alice, wrong)).statusCode, 422);
  assert.equal((await t.connect(t.alice, wrong)).statusCode, 429);
  const asked = t.fake.callsTo("ping").length;
  assert.equal((await t.connect(t.alice)).statusCode, 429, "even the right password waits");
  assert.equal(t.fake.callsTo("ping").length, asked, "Subsonic isn't asked");
  assert.equal((await t.connect(t.bob)).statusCode, 200, "someone else is unaffected");
  await finish(t);
});

test("sign-in attempts are also limited per address across accounts", async () => {
  const t = await setup({ extraUsers: ["carol", "dave", "erin"] });
  const wrong = { username: "tester", password: "guess" };
  for (const name of ["alice", "bob", "carol", "dave"]) {
    const who = await t.signIn(name);
    for (let i = 0; i < 5; i++) assert.equal((await t.connect(who, wrong)).statusCode, 422, `${name} ${i}`);
  }
  const erin = await t.signIn("erin");
  assert.equal((await t.connect(erin, wrong)).statusCode, 429);
  assert.equal((await t.connect(erin)).statusCode, 429);
  await finish(t);
});

test("successful sign-ins do not count against the limit", async () => {
  const t = await setup();
  for (let i = 0; i < 8; i++) assert.equal((await t.connect(t.alice)).statusCode, 200);
  await finish(t);
});

// ---- admin ------------------------------------------------------------------------------

test("admin: the address is validated, saved, and applies immediately", async () => {
  const t = await setup({ address: false });
  const put = (payload: object) => t.app.inject({ method: "PUT", url: "/api/admin/subsonic", headers: t.admin, payload });
  assert.deepEqual((await t.app.inject({ method: "GET", url: "/api/admin/subsonic", headers: t.admin })).json(), { serverUrl: null, source: null });
  for (const serverUrl of ["nonsense", "ftp://host", "http://user:pass@host", "http://host?x=1", "http://host#frag", "http://host/a b", 5]) {
    assert.equal((await put({ serverUrl })).statusCode, 400, String(serverUrl));
  }
  const ok = await put({ serverUrl: `${t.fake.url}/` });
  assert.deepEqual(ok.json() as AdminAddress, { serverUrl: t.fake.url, source: "admin" }, "trailing slash dropped");
  assert.equal((await t.connect(t.alice)).statusCode, 200, "applies without a restart");
  assert.deepEqual((await put({ serverUrl: null })).json(), { serverUrl: null, source: null });
  assert.deepEqual((await get(t, "/api/subsonic/status", t.alice)).json(), { configured: false, connected: false });
  // A path (server behind a reverse proxy) is kept.
  assert.equal(((await put({ serverUrl: "https://example.com/navidrome/" })).json() as AdminAddress).serverUrl, "https://example.com/navidrome");
  await finish(t);
});

test("admin: link-local and cloud metadata addresses are refused unless the admin insists", async () => {
  const t = await setup({ address: false });
  const put = (payload: object) => t.app.inject({ method: "PUT", url: "/api/admin/subsonic", headers: t.admin, payload });
  const attempts = [
    "http://169.254.169.254/latest/meta-data",
    "http://169.254.169.254",
    "http://2852039166/", // 169.254.169.254 as one decimal number
    "http://0xa9fea9fe/",
    "http://[::ffff:169.254.169.254]/",
    "http://[fd00:ec2::254]/",
    "http://[fe80::1]/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://100.100.100.200/",
    "http://169.254.170.2/v2/credentials",
  ];
  for (const serverUrl of attempts) {
    const res = await put({ serverUrl });
    assert.equal(res.statusCode, 400, serverUrl);
    assert.match(res.json().message, /metadata|link-local/);
    const test = await t.app.inject({ method: "POST", url: "/api/admin/subsonic/test", headers: t.admin, payload: { serverUrl } });
    assert.equal(test.statusCode, 400, `test ${serverUrl}`);
  }
  // Ordinary private addresses are the normal case for a home server.
  for (const serverUrl of ["http://192.168.1.20:4533", "http://10.0.0.5:4533", "http://localhost:4533", "http://navidrome:4533", "http://[::1]:4533"]) {
    assert.equal((await put({ serverUrl })).statusCode, 200, serverUrl);
  }
  // An admin who really means it can say so, explicitly.
  const forced = await put({ serverUrl: "http://169.254.10.10:4533", allowLinkLocal: true });
  assert.equal(forced.statusCode, 200);
  assert.equal(forced.json().serverUrl, "http://169.254.10.10:4533");
  await finish(t);
});

test("admin: SUBSONIC_URL wins over the saved address", async () => {
  const fake = await new FakeSubsonic().start();
  const t = await setup({ fake, plugin: { envUrl: fake.url } });
  assert.deepEqual((await t.app.inject({ method: "GET", url: "/api/admin/subsonic", headers: t.admin })).json(), { serverUrl: fake.url, source: "env" });
  const res = await t.app.inject({ method: "PUT", url: "/api/admin/subsonic", headers: t.admin, payload: { serverUrl: "http://elsewhere:1" } });
  assert.equal(res.statusCode, 409);
  assert.equal((await t.connect(t.alice)).statusCode, 200);
  await finish(t);
});

test("admin: a changed address never receives the old address's credentials", async () => {
  const t = await setup();
  await t.connect(t.alice);
  const other = await new FakeSubsonic().start();
  await t.app.inject({ method: "PUT", url: "/api/admin/subsonic", headers: t.admin, payload: { serverUrl: other.url } });
  assert.equal((await get(t, "/api/subsonic/status", t.alice)).json().connected, false);
  assert.equal((await get(t, "/api/subsonic/tracks", t.alice)).statusCode, 409);
  assert.equal(other.calls.length, 0, "no credentials went to the new address");
  assert.equal(storedRows(t.db).length, 0, "the stored sign-in was dropped");
  await other.stop();
  await finish(t);
});

test("admin: the test button checks an address without saving it or sending credentials", async () => {
  const t = await setup();
  const test = (serverUrl: unknown) => t.app.inject({ method: "POST", url: "/api/admin/subsonic/test", headers: t.admin, payload: { serverUrl } });
  const ok = (await test(`${t.fake.url}/`)).json() as AdminTestResult;
  // Without credentials the server answers "failed", which carries no name; it still proves the address is a Subsonic server.
  assert.deepEqual(ok, { ok: true });
  const probe = t.fake.callsTo("ping").at(-1)!;
  assert.equal(probe.query.u, undefined);
  assert.equal(probe.query.t, undefined);
  assert.equal(probe.query.p, undefined);
  assert.equal((await test("nonsense")).statusCode, 400);
  assert.equal((await test("http://u:p@host")).statusCode, 400);
  assert.equal((await test(undefined)).statusCode, 400);

  const notSubsonic = http.createServer((_q, res) => res.end("<html>hello</html>"));
  await new Promise<void>((r) => notSubsonic.listen(0, "127.0.0.1", r));
  const bad = (await test(`http://127.0.0.1:${(notSubsonic.address() as AddressInfo).port}`)).json() as AdminTestResult;
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /doesn't look like a Subsonic server/);
  notSubsonic.closeAllConnections();
  notSubsonic.close();

  const dead = await new FakeSubsonic().start();
  const deadUrl = dead.url;
  await dead.stop();
  const down = (await test(deadUrl)).json() as AdminTestResult;
  assert.equal(down.ok, false);
  assert.match(down.error!, /Couldn't reach/);
  assert.deepEqual((await t.app.inject({ method: "GET", url: "/api/admin/subsonic", headers: t.admin })).json(), { serverUrl: t.fake.url, source: "admin" }, "testing doesn't save");

  const redirect = http.createServer((_q, res) => {
    res.writeHead(302, { Location: `${t.fake.url}/rest/ping.view` });
    res.end();
  });
  await new Promise<void>((r) => redirect.listen(0, "127.0.0.1", r));
  const moved = (await test(`http://127.0.0.1:${(redirect.address() as AddressInfo).port}`)).json() as AdminTestResult;
  assert.equal(moved.ok, false);
  assert.match(moved.error!, /redirects/);
  redirect.closeAllConnections();
  redirect.close();
  await finish(t);
});