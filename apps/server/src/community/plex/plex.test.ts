import { test } from "node:test";
import assert from "node:assert/strict";
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
import { FakePlex, IDS, PAYLOAD } from "./fakePlex.js";
import { streamInfo, thumbId } from "./mapping.js";
import { createPlexPlugin, type PlexPluginOptions } from "./plugin.js";
import type { AdminAddress, AdminTestResult, Page, PlexAlbum, PlexPinPoll, PlexPinResponse, PlexStatus, PlexStreamUrl, PlexTrack } from "./types.js";

const SECRET = "s".repeat(64);

async function setup(opts: { fake?: FakePlex | null; plugin?: PlexPluginOptions; extraUsers?: string[]; address?: boolean } = {}) {
  const fake = opts.fake === null ? null : (opts.fake ?? (await new FakePlex().start()));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-plex-"));
  const db = openDb(":memory:");
  await createLocalUser(db, { username: "admin", password: "admin-password", isAdmin: true });
  await createLocalUser(db, { username: "alice", password: "alice-password" });
  await createLocalUser(db, { username: "bob", password: "bob-password" });
  for (const u of opts.extraUsers ?? []) await createLocalUser(db, { username: u, password: `${u}-password` });
  const config: Config = { host: "127.0.0.1", port: 0, dataDir: dir, musicDir: dir, scanIntervalMinutes: 0, trustProxy: false, logLevel: "silent" };
  const app = await buildApp({
    config,
    db,
    secret: SECRET,
    logger: false,
    plugins: [createPlexPlugin({ envUrl: "", plexTvUrl: fake?.tvUrl, ...opts.plugin })],
  });
  const signIn = async (username: string) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: `${username}-password` } });
    return { authorization: `Bearer ${(res.json() as AuthResponse).token}` };
  };
  const admin = await signIn("admin");
  if (fake && opts.address !== false) await app.inject({ method: "PUT", url: "/api/admin/plex", headers: admin, payload: { serverUrl: fake.url } });
  const startLink = (headers: { authorization: string }) => app.inject({ method: "POST", url: "/api/plex/pin", headers });
  const poll = (headers: { authorization: string }) => app.inject({ method: "GET", url: "/api/plex/pin", headers });
  /** The whole link flow for one person: get a code, enter it at plex.tv as `account`, let the app notice. */
  const pair = async (headers: { authorization: string }, account = "tester") => {
    const started = await startLink(headers);
    assert.equal(started.statusCode, 200, started.body);
    fake!.link((started.json() as PlexPinResponse).code, account);
    const done = await poll(headers);
    return { started, done, state: (done.json() as PlexPinPoll).state };
  };
  return { app, db, fake: fake as FakePlex, admin, alice: await signIn("alice"), bob: await signIn("bob"), signIn, startLink, poll, pair };
}
type T = Awaited<ReturnType<typeof setup>>;

const get = (t: T, url: string, who: { authorization: string }) => t.app.inject({ method: "GET", url, headers: who });
const page = <X>(res: { json: () => unknown }) => res.json() as Page<X>;

async function streamInfoFor(t: T, id: string, who: { authorization: string }) {
  const res = await get(t, `/api/plex/tracks/${id}/stream-url`, who);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as PlexStreamUrl;
  return { ...body, url: `/${body.path}` };
}

async function finish(t: T) {
  await t.app.close();
  await t.fake?.stop();
}

function userId(db: Db, name: string): number {
  return (db.prepare("SELECT id FROM users WHERE username = ?").get(name) as { id: number }).id;
}

function stored(db: Db, name: string): { clientId?: string; tokenEnc?: string; libraryKey?: string; userName?: string } | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(`plugin:cadence.plex:user:${userId(db, name)}`) as { value: string } | undefined;
  return row && JSON.parse(row.value);
}

function storedToken(db: Db, name: string): string | undefined {
  const enc = stored(db, name)?.tokenEnc;
  return enc ? (open(enc, SECRET, "plex-tokens") ?? undefined) : undefined;
}

// ---- mapping ---------------------------------------------------------------------

test("picture paths and stream info are validated, not trusted", () => {
  assert.equal(thumbId("/library/metadata/42/thumb/1700000000"), "42");
  assert.equal(thumbId("/library/metadata/42/thumb"), "42");
  assert.equal(thumbId("/library/metadata/42/../../etc"), undefined);
  assert.equal(thumbId("http://evil/library/metadata/42/thumb"), undefined);
  assert.equal(thumbId(42), undefined);
  const media = (container: string, audioCodec: string, key = "/library/parts/12/1700000000/file.flac") => ({ Media: [{ container, audioCodec, Part: [{ key }] }] });
  assert.deepEqual(streamInfo(media("flac", "flac")), { mode: "direct", partKey: "/library/parts/12/1700000000/file.flac" });
  assert.equal(streamInfo(media("mp4", "alac"))!.mode, "transcode", "ALAC in an m4a does not play in browsers");
  assert.equal(streamInfo(media("ogg", "vorbis"))!.mode, "transcode");
  assert.equal(streamInfo(media("flac", "flac", "/library/parts/12/../../../etc/passwd")), null, "a part key that is not a part path is refused");
  assert.equal(streamInfo(media("flac", "flac", "http://evil/x")), null);
  assert.equal(streamInfo({}), null);
});

// ---- linking ------------------------------------------------------------------------

test("link flow: a code from plex.tv, the token is encrypted at rest and never returned", async () => {
  const t = await setup();
  assert.deepEqual((await get(t, "/api/plex/status", t.alice)).json(), { configured: true, connected: false });
  assert.equal((await t.poll(t.alice)).statusCode, 404, "polling before starting");

  const started = await t.startLink(t.alice);
  const pin = started.json() as PlexPinResponse;
  assert.equal(pin.code, "ABCD");
  assert.equal(pin.linkUrl, "https://plex.tv/link");
  assert.ok(pin.expiresAt > Date.now());
  assert.ok(!started.body.includes("authToken"));
  // plex.tv was asked for a short (non-strong) code, identifying Cadence and this person's device.
  const asked = t.fake.tvCalls[0];
  assert.equal(asked.path, "/api/v2/pins");
  assert.equal(asked.headers["x-plex-product"], "Cadence");
  assert.match(String(asked.headers["x-plex-client-identifier"]), /^cadence-\d+-[0-9a-f]{16}$/);

  // Not entered yet: waiting.
  assert.deepEqual((await t.poll(t.alice)).json(), { state: "waiting", expiresAt: pin.expiresAt });
  assert.equal(stored(t.db, "alice")?.tokenEnc, undefined);

  const token = t.fake.link(pin.code, "tester");
  const done = await t.poll(t.alice);
  assert.equal(done.statusCode, 200);
  const body = done.json() as PlexPinPoll;
  assert.equal(body.state, "connected");
  assert.deepEqual((body as { status: PlexStatus }).status, {
    configured: true,
    connected: true,
    serverName: "Fake Plex",
    userName: "tester",
    library: { key: "1", title: "Music" },
  });
  assert.ok(!done.body.includes(token), "the token never goes to the app");
  assert.ok(!(await get(t, "/api/plex/status", t.alice)).body.includes(token));

  const row = JSON.stringify(t.db.prepare("SELECT value FROM settings WHERE key LIKE 'plugin:cadence.plex:%'").all());
  assert.ok(!row.includes(token), "encrypted at rest");
  assert.equal(storedToken(t.db, "alice"), token);
  assert.equal(open(stored(t.db, "alice")!.tokenEnc!, SECRET), null, "not readable as an AI provider key");

  // The server's calls carry the token in a header only, and identify the same device as the link did.
  await get(t, "/api/plex/albums", t.alice);
  const call = t.fake.callsTo("/library/sections/1/all")[0];
  assert.equal(call.headers["x-plex-token"], token);
  assert.equal(call.headers["x-plex-client-identifier"], asked.headers["x-plex-client-identifier"]);
  assert.equal(call.headers.accept, "application/json");
  assert.equal(t.fake.tokenInUrl, false, "tokens never appear in URLs");

  // A code is single use: polling again finds nothing to do.
  assert.equal((await t.poll(t.alice)).statusCode, 404);

  assert.equal((await t.app.inject({ method: "DELETE", url: "/api/plex/connection", headers: t.alice })).statusCode, 204);
  assert.deepEqual((await get(t, "/api/plex/status", t.alice)).json(), { configured: true, connected: false });
  assert.equal(storedToken(t.db, "alice"), undefined);
  assert.ok(stored(t.db, "alice")?.clientId, "the device id is kept");
  assert.equal((await get(t, "/api/plex/tracks", t.alice)).json().error, "plex_not_connected");
  await finish(t);
});

test("link flow: an expired code, and an account without access to the owner's server", async () => {
  const t = await setup();
  await t.startLink(t.alice);
  t.fake.expireAllPins();
  assert.deepEqual((await t.poll(t.alice)).json(), { state: "expired" });
  assert.equal((await t.poll(t.alice)).statusCode, 404, "an expired code is forgotten");

  // Entered by an account the server does not share with: the token is thrown away.
  const r = await t.pair(t.alice, "stranger");
  assert.equal(r.state, "no_access");
  assert.equal(stored(t.db, "alice")?.tokenEnc, undefined);
  assert.deepEqual((await get(t, "/api/plex/status", t.alice)).json(), { configured: true, connected: false });

  // Local expiry too.
  let clock = 1_000_000;
  const t2 = await setup({ plugin: { now: () => clock } });
  await t2.startLink(t2.alice);
  clock += 2 * 3600_000;
  assert.deepEqual((await t2.poll(t2.alice)).json(), { state: "expired" });
  await finish(t2);
  await finish(t);
});

test("link flow: starting codes is rate limited per person", async () => {
  const t = await setup();
  for (let i = 0; i < 10; i++) assert.equal((await t.startLink(t.alice)).statusCode, 200);
  assert.equal((await t.startLink(t.alice)).statusCode, 429);
  assert.equal((await t.startLink(t.bob)).statusCode, 200, "someone else is unaffected");
  await finish(t);
});

test("link flow: not configured is 409; unreachable plex.tv is a generic 502", async () => {
  const t = await setup({ fake: null });
  assert.deepEqual((await get(t, "/api/plex/status", t.alice)).json(), { configured: false, connected: false });
  assert.equal((await t.startLink(t.alice)).json().error, "plex_not_configured");
  assert.equal((await t.poll(t.alice)).statusCode, 409);
  await t.app.close();

  const fake = await new FakePlex().start();
  const tvUrl = fake.tvUrl;
  const t2 = await setup({ fake, plugin: { plexTvUrl: "http://127.0.0.1:1" } });
  const res = await t2.startLink(t2.alice);
  assert.equal(res.statusCode, 502);
  assert.ok(!res.body.includes("127.0.0.1") && !res.body.includes("ECONNREFUSED"));
  assert.notEqual(tvUrl, "http://127.0.0.1:1");
  await finish(t2);
});

test("a person with several music libraries chooses one; only the server's own libraries are accepted", async () => {
  const fake = await new FakePlex().start();
  fake.twoLibraries = true;
  const t = await setup({ fake });
  const r = await t.pair(t.alice);
  const status = (r.done.json() as { status: PlexStatus }).status;
  assert.equal(status.needsLibrary, true);
  assert.equal(status.library, undefined);
  assert.equal((await get(t, "/api/plex/tracks", t.alice)).json().error, "plex_no_library");

  const libs = (await get(t, "/api/plex/libraries", t.alice)).json() as { items: { key: string; title: string }[]; selected: string | null };
  assert.deepEqual(libs.items, [{ key: "1", title: "Music" }, { key: "3", title: "Podcasts and live" }]);
  assert.equal(libs.selected, null, "movies are not offered");

  const put = (key: unknown) => t.app.inject({ method: "PUT", url: "/api/plex/library", headers: t.alice, payload: { key } });
  assert.equal((await put("2")).statusCode, 404, "a movie library is not a music library");
  assert.equal((await put("99")).statusCode, 404);
  assert.equal((await put("../x")).statusCode, 400);
  assert.equal((await put(1)).statusCode, 400);
  const ok = await put("3");
  assert.equal(ok.statusCode, 200);
  assert.deepEqual((ok.json() as PlexStatus).library, { key: "3", title: "Podcasts and live" });
  await get(t, "/api/plex/albums", t.alice);
  assert.equal(t.fake.callsTo(/\/library\/sections\/\d+\/all/).at(-1)!.path, "/library/sections/3/all");
  assert.equal(stored(t.db, "alice")?.libraryKey, "3");
  await finish(t);
});

test("every route needs a signed-in Cadence user (except the signed stream and image URLs)", async () => {
  const t = await setup();
  const routes: [string, string][] = [
    ["GET", "/api/plex/status"],
    ["POST", "/api/plex/pin"],
    ["GET", "/api/plex/pin"],
    ["DELETE", "/api/plex/connection"],
    ["GET", "/api/plex/libraries"],
    ["PUT", "/api/plex/library"],
    ["GET", "/api/plex/tracks"],
    ["GET", "/api/plex/albums"],
    ["GET", "/api/plex/artists"],
    ["GET", "/api/plex/albums/21/tracks"],
    ["GET", "/api/plex/playlists"],
    ["GET", "/api/plex/playlists/700/tracks"],
    ["PUT", "/api/plex/favourites/101"],
    ["DELETE", "/api/plex/favourites/101"],
    ["GET", "/api/plex/tracks/101/stream-url"],
    ["POST", "/api/plex/playback"],
    ["GET", "/api/admin/plex"],
    ["PUT", "/api/admin/plex"],
    ["POST", "/api/admin/plex/test"],
  ];
  for (const [method, url] of routes) {
    assert.equal((await t.app.inject({ method: method as "GET", url })).statusCode, 401, `${method} ${url}`);
  }
  for (const [method, url] of routes.filter(([, u]) => u.startsWith("/api/admin"))) {
    assert.equal((await t.app.inject({ method: method as "GET", url, headers: t.alice, payload: {} })).statusCode, 403, `${method} ${url}`);
  }
  assert.equal(t.fake.calls.length + t.fake.tvCalls.length, 0);
  await finish(t);
});

// ---- per-user isolation ---------------------------------------------------------------

test("people cannot point the server anywhere: addresses come from the owner, never from a request", async () => {
  const t = await setup();
  const evil = await new FakePlex().start();
  await t.pair(t.alice);
  const smuggled = `serverUrl=${encodeURIComponent(evil.url)}&url=${encodeURIComponent(evil.url)}&baseUrl=${encodeURIComponent(evil.url)}`;
  assert.equal((await get(t, `/api/plex/tracks?${smuggled}`, t.alice)).statusCode, 200);
  const res = await t.app.inject({
    method: "GET",
    url: "/api/plex/albums",
    headers: { ...t.alice, host: new URL(evil.url).host, "x-forwarded-host": new URL(evil.url).host },
  });
  assert.equal(res.statusCode, 200);
  assert.equal((await t.app.inject({ method: "POST", url: "/api/plex/pin", headers: t.alice, payload: { plexTvUrl: evil.tvUrl, serverUrl: evil.url } })).statusCode, 200);
  assert.equal(evil.calls.length + evil.tvCalls.length, 0, "nothing a person sends is used as an address");
  await evil.stop();
  await finish(t);
});

test("per-user isolation: separate Plex accounts, ratings, tokens and links", async () => {
  const t = await setup();
  assert.equal((await t.pair(t.alice, "tester")).state, "connected");
  // Bob starts a link while Alice is connected; Alice's token is untouched.
  const aliceToken = storedToken(t.db, "alice")!;
  const bobStart = await t.startLink(t.bob);
  assert.equal(storedToken(t.db, "alice"), aliceToken);
  // Alice cannot complete Bob's link (the pin lives server-side per person), and Bob's poll is his own.
  t.fake.link((bobStart.json() as PlexPinResponse).code, "other");
  assert.equal(((await t.poll(t.bob)).json() as PlexPinPoll).state, "connected");
  assert.notEqual(storedToken(t.db, "bob"), aliceToken);
  assert.equal(stored(t.db, "alice")!.clientId !== stored(t.db, "bob")!.clientId, true, "each person is their own device");
  assert.equal((await get(t, "/api/plex/status", t.bob)).json().userName, "other");
  assert.equal((await get(t, "/api/plex/status", t.alice)).json().userName, "tester");

  // Alice hearts a track; Bob's account does not see it.
  assert.equal((await t.app.inject({ method: "PUT", url: "/api/plex/favourites/101", headers: t.alice })).statusCode, 204);
  assert.deepEqual(page<PlexTrack>(await get(t, "/api/plex/tracks?favourites=1", t.alice)).items.map((x) => x.id), ["101"]);
  assert.deepEqual(page<PlexTrack>(await get(t, "/api/plex/tracks?favourites=1", t.bob)).items, []);
  assert.equal(t.fake.callsTo("/:/rate")[0].headers["x-plex-token"], aliceToken);
  const bobList = await get(t, "/api/plex/tracks", t.bob);
  assert.equal(t.fake.callsTo("/library/sections/1/all").at(-1)!.headers["x-plex-token"], storedToken(t.db, "bob"));
  assert.ok(!bobList.body.includes(aliceToken));

  // A stream link signed for Alice does not work as Bob.
  const alice = await streamInfoFor(t, IDS.dance, t.alice);
  assert.equal((await t.app.inject({ method: "GET", url: alice.url.replace(/u=\d+/, `u=${userId(t.db, "bob")}`) })).statusCode, 403);
  // Disconnecting one leaves the other.
  await t.app.inject({ method: "DELETE", url: "/api/plex/connection", headers: t.bob });
  assert.equal((await t.app.inject({ method: "GET", url: alice.url })).statusCode, 200);
  await finish(t);
});

test("stored sign-ins of people who were deleted are swept up", async () => {
  const t = await setup();
  await t.pair(t.alice);
  await t.pair(t.bob, "other");
  t.db.prepare("DELETE FROM users WHERE username = 'alice'").run();
  assert.equal(pruneOrphanedUserConfig(t.db, "cadence.plex"), 1);
  assert.equal(storedToken(t.db, "bob") !== undefined, true);
  await finish(t);
});
// ---- browsing -------------------------------------------------------------------------

async function connected(opts: Parameters<typeof setup>[0] = {}) {
  const t = await setup(opts);
  const r = await t.pair(t.alice);
  assert.equal(r.state, "connected", r.done.body);
  return t;
}

test("tracks, albums, artists and playlists are mapped, with signed relative artwork paths", async () => {
  const t = await connected();
  const all = page<PlexTrack>(await get(t, "/api/plex/tracks", t.alice));
  assert.equal(all.total, 6);
  assert.equal(all.items.length, 6);
  const first = all.items.find((x) => x.id === "101")!;
  assert.deepEqual(
    { ...first, artwork: undefined },
    { id: "101", title: "One More Time", artists: ["Daft Punk"], album: "Discovery", albumId: "21", artistId: "11", durationSec: 200, trackNo: 1, favourite: false, playCount: 0, artwork: undefined },
  );
  assert.match(first.artwork!, /^api\/plex\/image\/21\?u=\d+&exp=\d+&sig=[\w-]+$/, "the album's picture");
  assert.ok(!JSON.stringify(all).includes("http"), "no absolute URLs");
  const listing = t.fake.callsTo("/library/sections/1/all")[0].query;
  assert.equal(listing.type, "10");
  assert.equal(listing["X-Plex-Container-Start"], "0");
  assert.equal(listing["X-Plex-Container-Size"], "100");

  const albums = page<PlexAlbum>(await get(t, "/api/plex/albums", t.alice));
  assert.deepEqual(albums.items.map((a) => a.name), ["Cross", "Discovery", "Nothing", "Random Access Memories"]);
  assert.deepEqual({ ...albums.items[1], artwork: undefined }, { id: "21", name: "Discovery", artist: "Daft Punk", artistId: "11", year: 2001, trackCount: 1, artwork: undefined });
  assert.equal(albums.hasMore, false);
  assert.deepEqual(page<PlexAlbum>(await get(t, "/api/plex/albums?artistId=11", t.alice)).items.map((a) => a.id), ["21", "23"]);
  assert.deepEqual(page<PlexAlbum>(await get(t, "/api/plex/albums?q=cross", t.alice)).items.map((a) => a.id), ["22"]);
  assert.equal(t.fake.callsTo("/library/sections/1/all").at(-1)!.query.title, "cross");
  await get(t, "/api/plex/albums?sort=newest", t.alice);
  assert.equal(t.fake.callsTo("/library/sections/1/all").at(-1)!.query.sort, "addedAt:desc");
  await get(t, "/api/plex/albums?sort=../../etc", t.alice);
  assert.equal(t.fake.callsTo("/library/sections/1/all").at(-1)!.query.sort, "titleSort");

  assert.deepEqual(page<PlexTrack>(await get(t, "/api/plex/albums/23/tracks", t.alice)).items.map((x) => x.id), ["103", "104"]);
  const artists = page<{ id: string; name: string; albumCount?: number }>(await get(t, "/api/plex/artists", t.alice));
  assert.deepEqual(artists.items.map((x) => [x.name, x.albumCount]), [["Daft Punk", 2], ["Justice", 1], ["Nobody", 1]]);
  assert.deepEqual(page<{ name: string }>(await get(t, "/api/plex/artists?q=jus", t.alice)).items.map((x) => x.name), ["Justice"]);

  const playlists = (await get(t, "/api/plex/playlists", t.alice)).json() as { items: { id: string; name: string; trackCount: number }[] };
  assert.deepEqual(playlists.items, [{ id: "700", name: "Night drive", trackCount: 2 }]);
  assert.equal(t.fake.callsTo("/playlists")[0].query.playlistType, "audio");
  assert.deepEqual(page<PlexTrack>(await get(t, "/api/plex/playlists/700/tracks", t.alice)).items.map((x) => x.id), ["101", "102"]);
  await finish(t);
});

test("paging: Plex's total is used, limits are clamped", async () => {
  const t = await connected();
  const two = page<PlexTrack>(await get(t, "/api/plex/tracks?limit=2", t.alice));
  assert.equal(two.items.length, 2);
  assert.equal(two.total, 6);
  assert.equal(two.hasMore, true);
  const rest = page<PlexTrack>(await get(t, "/api/plex/tracks?limit=10&offset=2", t.alice));
  assert.equal(rest.items.length, 4);
  assert.equal(rest.hasMore, false);
  assert.equal(t.fake.callsTo("/library/sections/1/all").at(-1)!.query["X-Plex-Container-Start"], "2");
  await get(t, "/api/plex/tracks?limit=99999", t.alice);
  assert.equal(t.fake.callsTo("/library/sections/1/all").at(-1)!.query["X-Plex-Container-Size"], "500");
  await get(t, "/api/plex/tracks?limit=banana&offset=-5", t.alice);
  assert.equal(t.fake.callsTo("/library/sections/1/all").at(-1)!.query["X-Plex-Container-Size"], "100");
  assert.equal(t.fake.callsTo("/library/sections/1/all").at(-1)!.query["X-Plex-Container-Start"], "0");
  await finish(t);
});

test("a text search also finds tracks by artist and by album, titles first, without repeats", async () => {
  const t = await connected();
  assert.deepEqual(page<PlexTrack>(await get(t, "/api/plex/tracks?q=daft", t.alice)).items.map((x) => x.id).sort(), ["101", "103", "104"]);
  assert.deepEqual(page<PlexTrack>(await get(t, "/api/plex/tracks?q=random", t.alice)).items.map((x) => x.id).sort(), ["103", "104"]);
  const lucky = page<PlexTrack>(await get(t, "/api/plex/tracks?q=get%20lucky", t.alice));
  assert.deepEqual(lucky.items.map((x) => x.id), ["103"]);
  const hub = t.fake.callsTo("/hubs/search").at(-1)!.query;
  assert.equal(hub.query, "get lucky");
  assert.equal(hub.sectionId, "1", "search stays inside the chosen library");
  const dupes = page<PlexTrack>(await get(t, "/api/plex/tracks?q=d", t.alice));
  assert.equal(new Set(dupes.items.map((x) => x.id)).size, dupes.items.length);
  assert.equal(page<PlexTrack>(await get(t, "/api/plex/tracks?q=zzzz", t.alice)).items.length, 0);
  await finish(t);
});

test("ids that go into Plex requests must be plain numbers", async () => {
  const t = await connected();
  const before = t.fake.calls.length;
  for (const bad of ["a", "1a", "1%2F2", "..%2F..", "1%3Fx%3D1", "%00", "1".repeat(40)]) {
    for (const url of [`/api/plex/albums/${bad}/tracks`, `/api/plex/playlists/${bad}/tracks`, `/api/plex/tracks/${bad}/stream-url`, `/api/plex/stream/${bad}`, `/api/plex/image/${bad}`]) {
      const res = await get(t, url, t.alice);
      assert.ok(res.statusCode >= 400 && res.statusCode < 500, `${url} -> ${res.statusCode}`);
    }
    assert.notEqual((await t.app.inject({ method: "PUT", url: `/api/plex/favourites/${bad}`, headers: t.alice })).statusCode, 204);
  }
  assert.equal((await get(t, "/api/plex/tracks?albumId=1%2F2", t.alice)).statusCode, 400);
  assert.equal((await get(t, "/api/plex/albums?artistId=x", t.alice)).statusCode, 400);
  assert.equal(t.fake.calls.length, before, "nothing was sent upstream");
  await finish(t);
});

test("favourites: rating 10 and 0 in the person's own Plex account", async () => {
  const t = await connected();
  assert.equal((await t.app.inject({ method: "PUT", url: "/api/plex/favourites/102", headers: t.alice })).statusCode, 204);
  const call = t.fake.callsTo("/:/rate")[0].query;
  assert.deepEqual({ key: call.key, rating: call.rating, identifier: call.identifier }, { key: "102", rating: "10", identifier: "com.plexapp.plugins.library" });
  const tracks = page<PlexTrack>(await get(t, "/api/plex/tracks", t.alice));
  assert.equal(tracks.items.find((x) => x.id === "102")!.favourite, true);
  assert.equal(tracks.items.find((x) => x.id === "101")!.favourite, false);
  assert.deepEqual(page<PlexTrack>(await get(t, "/api/plex/tracks?favourites=1", t.alice)).items.map((x) => x.id), ["102"]);
  assert.equal(t.fake.callsTo("/library/sections/1/all").at(-1)!.query["userRating>>"], "8");
  assert.equal((await t.app.inject({ method: "DELETE", url: "/api/plex/favourites/102", headers: t.alice })).statusCode, 204);
  assert.equal(t.fake.callsTo("/:/rate")[1].query.rating, "0");
  assert.deepEqual(page<PlexTrack>(await get(t, "/api/plex/tracks?favourites=1", t.alice)).items, []);
  assert.equal((await t.app.inject({ method: "PUT", url: "/api/plex/favourites/999", headers: t.alice })).statusCode, 502, "a rating Plex refuses is an upstream error, not success");
  await finish(t);
});

test("playback reports become timeline updates and a scrobble only for real listens", async () => {
  const t = await connected();
  const post = (payload: object) => t.app.inject({ method: "POST", url: "/api/plex/playback", headers: t.alice, payload });
  assert.equal((await post({ event: "start", itemId: "102", positionSec: 0, durationSec: 200 })).statusCode, 204);
  assert.deepEqual(t.fake.timeline.at(-1), { id: "102", state: "playing", time: 0 });
  assert.equal(t.fake.callsTo("/:/timeline")[0].query.duration, "200000");
  await post({ event: "stop", itemId: "102", positionSec: 10, durationSec: 200 });
  assert.deepEqual(t.fake.timeline.at(-1), { id: "102", state: "stopped", time: 10000 });
  assert.equal(t.fake.plays.get("102") ?? 0, 0, "skipped after 10 s: not a play");
  await post({ event: "stop", itemId: "102", positionSec: 150, durationSec: 200 });
  assert.equal(t.fake.plays.get("102"), 1);
  for (const bad of [{}, { event: "pause", itemId: "1", positionSec: 1 }, { event: "stop", itemId: "x", positionSec: 1 }, { event: "stop", itemId: "1", positionSec: -1 }, { event: "stop", itemId: "1", positionSec: "9" }]) {
    assert.equal((await post(bad)).statusCode, 400, JSON.stringify(bad));
  }
  t.fake.failWith = "boom";
  assert.equal((await post({ event: "start", itemId: "102", positionSec: 0 })).statusCode, 204, "reporting is best effort");
  await finish(t);
});

// ---- failures ---------------------------------------------------------------------------

test("a rejected token drops the stale connection and asks the person to link again (409, never 401)", async () => {
  const t = await connected();
  t.fake.access.delete("tester");
  const res = await get(t, "/api/plex/tracks", t.alice);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "plex_session_expired");
  assert.deepEqual((await get(t, "/api/plex/status", t.alice)).json(), { configured: true, connected: false });
  assert.equal(storedToken(t.db, "alice"), undefined);
  await finish(t);
});

test("clients never see upstream text or network details", async () => {
  const t = await connected();
  t.fake.failWith = "stack trace at /srv/secret X-Plex-Token=hunter2";
  const res = await get(t, "/api/plex/tracks", t.alice);
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, "plex_failed");
  assert.ok(!res.body.includes("hunter2") && !res.body.includes("/srv") && !res.body.includes("127.0.0.1"));
  await finish(t);
});

test("redirects to another address are not followed (the token would go with them)", async () => {
  const t = await connected();
  const elsewhere = await new FakePlex().start();
  t.fake.redirectTo = elsewhere.url;
  const res = await get(t, "/api/plex/tracks", t.alice);
  assert.equal(res.statusCode, 502);
  assert.equal(elsewhere.calls.length, 0, "no token went to the redirect target");
  await elsewhere.stop();
  await finish(t);
});

test("an oversized answer is refused, not buffered", async () => {
  const t = await connected();
  t.fake.huge = true;
  const res = await get(t, "/api/plex/tracks", t.alice);
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().message, "Plex sent more than Cadence accepts");
  await finish(t);
});
// ---- streaming ----------------------------------------------------------------------------

test("stream: direct play passes the original through, with ranges", async () => {
  const t = await connected();
  const s = await streamInfoFor(t, IDS.dance, t.alice);
  assert.equal(s.mode, "direct");
  assert.match(s.url, new RegExp(`^/api/plex/stream/${IDS.dance}\\?u=\\d+&exp=\\d+&sig=`));
  assert.ok(Math.abs(s.expiresAt - (Date.now() / 1000 + 6 * 3600)) < 30, "six hours");

  const whole = await t.app.inject({ method: "GET", url: s.url });
  assert.equal(whole.statusCode, 200);
  assert.equal(whole.headers["content-type"], "audio/mpeg");
  assert.equal(whole.headers["content-length"], String(PAYLOAD.length));
  assert.equal(whole.headers["accept-ranges"], "bytes");
  assert.deepEqual(whole.rawPayload, PAYLOAD);
  const part = await t.app.inject({ method: "GET", url: s.url, headers: { range: "bytes=100-199" } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers["content-range"], `bytes 100-199/${PAYLOAD.length}`);
  assert.deepEqual(part.rawPayload, PAYLOAD.subarray(100, 200));
  const tail = await t.app.inject({ method: "GET", url: s.url, headers: { range: "bytes=1990-" } });
  assert.equal(tail.rawPayload.length, 10);
  const suffix = await t.app.inject({ method: "GET", url: s.url, headers: { range: "bytes=-5" } });
  assert.deepEqual(suffix.rawPayload, PAYLOAD.subarray(PAYLOAD.length - 5));
  const past = await t.app.inject({ method: "GET", url: s.url, headers: { range: "bytes=5000-6000" } });
  assert.equal(past.statusCode, 416);
  assert.equal(past.headers["content-range"], `bytes */${PAYLOAD.length}`);
  const odd = await t.app.inject({ method: "GET", url: s.url, headers: { range: "bytes=0-1,5-9" } });
  assert.equal(odd.statusCode, 200);

  const parts = t.fake.callsTo(/^\/library\/parts\//);
  assert.equal(parts[0].path, "/library/parts/102/1700000000/file.mp3");
  assert.equal(parts[1].headers.range, "bytes=100-199");
  assert.equal(parts.at(-1)!.headers.range, undefined, "a multi-range request is not forwarded");
  assert.match(String(parts[0].headers["x-plex-token"]), /^plextok-tester-/);
  assert.equal(t.fake.callsTo(/transcode/).length, 0, "no transcoding for a file browsers can play");
  assert.equal(t.fake.callsTo("/library/metadata/102").length, 1, "looked up once, not for every range request");
  assert.equal(t.fake.tokenInUrl, false);
  await finish(t);
});

test("stream: files browsers cannot play fall back to Plex's MP3 transcode", async () => {
  const t = await connected();
  const ogg = await streamInfoFor(t, IDS.oggSong, t.alice);
  assert.equal(ogg.mode, "transcode");
  const res = await t.app.inject({ method: "GET", url: ogg.url });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "audio/mpeg");
  const call = t.fake.callsTo("/music/:/transcode/universal/start.mp3")[0];
  assert.equal(call.query.path, "/library/metadata/104");
  assert.equal(call.query.protocol, "http");
  assert.equal(call.query.directPlay, "0");
  assert.equal(t.fake.callsTo(/^\/library\/parts\//).length, 0);
  const aac = await streamInfoFor(t, IDS.getLucky, t.alice);
  assert.equal(aac.mode, "direct", "AAC in an m4a plays as is");
  assert.equal((await t.app.inject({ method: "GET", url: aac.url })).headers["content-type"], "audio/mp4");
  await finish(t);
});

test("cover art goes through Plex's photo transcoder at a bounded size, only as an image", async () => {
  const t = await connected();
  const tracks = page<PlexTrack>(await get(t, "/api/plex/tracks", t.alice));
  const art = `/${tracks.items[0].artwork}`;
  const res = await t.app.inject({ method: "GET", url: art });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/jpeg");
  assert.deepEqual([...res.rawPayload], [0xff, 0xd8, 0xff, 0xd9]);
  const call = t.fake.callsTo("/photo/:/transcode")[0];
  assert.equal(call.query.url, "/library/metadata/21/thumb");
  assert.equal(call.query.width, "300");
  await t.app.inject({ method: "GET", url: `${art}&w=99999` });
  assert.equal(t.fake.callsTo("/photo/:/transcode")[1].query.width, "1200");
  await finish(t);
});

test("stream and image URLs: bad, expired, other-user and cross-kind signatures are refused", async () => {
  const t = await connected();
  const { url } = await streamInfoFor(t, IDS.dance, t.alice);
  const bump = (s: string) => s.slice(0, -2) + (s.endsWith("aa") ? "bb" : "aa");
  assert.equal((await t.app.inject({ method: "GET", url: bump(url) })).statusCode, 403, "tampered signature");
  assert.equal((await t.app.inject({ method: "GET", url: url.replace(/sig=[^&]+/, "") })).statusCode, 403, "missing signature");
  assert.equal((await t.app.inject({ method: "GET", url: url.replace(/exp=\d+/, "exp=1") })).statusCode, 403, "expired");
  assert.equal((await t.app.inject({ method: "GET", url: url.replace(`/${IDS.dance}?`, `/${IDS.oneMoreTime}?`) })).statusCode, 403, "different item");
  assert.equal((await t.app.inject({ method: "GET", url: url.replace("/stream/", "/image/") })).statusCode, 403, "a stream link is not an image link");
  const tracks = page<PlexTrack>(await get(t, "/api/plex/tracks", t.alice));
  assert.equal((await t.app.inject({ method: "GET", url: `/${tracks.items[0].artwork}`.replace("/image/", "/stream/") })).statusCode, 403);
  assert.equal(t.fake.callsTo(/^\/library\/parts\//).length, 0);
  await finish(t);
});

test("stream-url: tracks Plex does not know are 404, albums are not streamable, nobody else's sign-in is used", async () => {
  const t = await connected();
  assert.equal((await get(t, `/api/plex/tracks/${IDS.gone}/stream-url`, t.alice)).statusCode, 404);
  assert.equal((await get(t, "/api/plex/tracks/21/stream-url", t.alice)).statusCode, 404, "an album id is not a track");
  assert.equal((await get(t, `/api/plex/tracks/${IDS.dance}/stream-url`, t.bob)).json().error, "plex_not_connected");
  const { url } = await streamInfoFor(t, IDS.dance, t.alice);
  await t.app.inject({ method: "DELETE", url: "/api/plex/connection", headers: t.alice });
  assert.equal((await t.app.inject({ method: "GET", url })).statusCode, 409, "the link stops working with the sign-in");
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

test("stream: when the client goes away the request to Plex is cancelled", async () => {
  const t = await connected();
  const base = await listen(t);
  const url = `${base}${(await streamInfoFor(t, IDS.endless, t.alice)).url}`;
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
  assert.ok(await until(() => t.fake.aborted.includes(IDS.endless)), "Plex saw the request end");
  await finish(t);
});

test("stream: a Plex that stops sending is cut off", async () => {
  const t = await connected({ plugin: { streamIdleMs: 150 } });
  const base = await listen(t);
  const url = `${base}${(await streamInfoFor(t, IDS.stall, t.alice)).url}`;
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

// ---- admin --------------------------------------------------------------------------------

test("admin: the address is validated, saved, and applies immediately", async () => {
  const t = await setup({ address: false });
  const put = (payload: object) => t.app.inject({ method: "PUT", url: "/api/admin/plex", headers: t.admin, payload });
  assert.deepEqual((await t.app.inject({ method: "GET", url: "/api/admin/plex", headers: t.admin })).json(), { serverUrl: null, source: null });
  for (const serverUrl of ["nonsense", "ftp://host", "http://user:pass@host", "http://host?x=1", "http://host#frag", 5]) {
    assert.equal((await put({ serverUrl })).statusCode, 400, String(serverUrl));
  }
  assert.deepEqual((await put({ serverUrl: `${t.fake.url}/` })).json() as AdminAddress, { serverUrl: t.fake.url, source: "admin" });
  assert.equal((await t.startLink(t.alice)).statusCode, 200, "applies without a restart");
  assert.deepEqual((await put({ serverUrl: null })).json(), { serverUrl: null, source: null });
  assert.deepEqual((await get(t, "/api/plex/status", t.alice)).json(), { configured: false, connected: false });
  await finish(t);
});

test("admin: link-local and cloud metadata addresses are refused unless the admin insists", async () => {
  const t = await setup({ address: false });
  const put = (payload: object) => t.app.inject({ method: "PUT", url: "/api/admin/plex", headers: t.admin, payload });
  for (const serverUrl of ["http://169.254.169.254/latest/meta-data", "http://2852039166/", "http://[::ffff:169.254.169.254]/", "http://[fd00:ec2::254]/", "http://metadata.google.internal/", "http://169.254.170.2/"]) {
    const res = await put({ serverUrl });
    assert.equal(res.statusCode, 400, serverUrl);
    const probe = await t.app.inject({ method: "POST", url: "/api/admin/plex/test", headers: t.admin, payload: { serverUrl } });
    assert.equal(probe.statusCode, 400, `test ${serverUrl}`);
  }
  for (const serverUrl of ["http://192.168.1.20:32400", "http://plex:32400", "http://localhost:32400"]) assert.equal((await put({ serverUrl })).statusCode, 200, serverUrl);
  assert.equal((await put({ serverUrl: "http://169.254.10.10:32400", allowLinkLocal: true })).statusCode, 200);
  await finish(t);
});

test("admin: PLEX_URL wins over the saved address", async () => {
  const fake = await new FakePlex().start();
  const t = await setup({ fake, plugin: { envUrl: fake.url } });
  assert.deepEqual((await t.app.inject({ method: "GET", url: "/api/admin/plex", headers: t.admin })).json(), { serverUrl: fake.url, source: "env" });
  assert.equal((await t.app.inject({ method: "PUT", url: "/api/admin/plex", headers: t.admin, payload: { serverUrl: "http://elsewhere:1" } })).statusCode, 409);
  assert.equal((await t.pair(t.alice)).state, "connected");
  await finish(t);
});

test("admin: a changed address never receives the old address's tokens", async () => {
  const t = await connected();
  const other = await new FakePlex().start();
  await t.app.inject({ method: "PUT", url: "/api/admin/plex", headers: t.admin, payload: { serverUrl: other.url } });
  assert.equal((await get(t, "/api/plex/status", t.alice)).json().connected, false);
  assert.equal((await get(t, "/api/plex/tracks", t.alice)).statusCode, 409);
  assert.equal(other.calls.length, 0, "no token went to the new address");
  assert.equal(storedToken(t.db, "alice"), undefined);
  await other.stop();
  await finish(t);
});

test("admin: the test button checks an address without saving it or sending a token", async () => {
  const t = await setup();
  const test = (serverUrl: unknown) => t.app.inject({ method: "POST", url: "/api/admin/plex/test", headers: t.admin, payload: { serverUrl } });
  assert.deepEqual((await test(`${t.fake.url}/`)).json() as AdminTestResult, { ok: true, version: "1.40.0.1" });
  assert.equal(t.fake.calls.at(-1)!.headers["x-plex-token"], undefined);
  assert.equal((await test("nonsense")).statusCode, 400);
  assert.equal((await test(undefined)).statusCode, 400);

  const notPlex = http.createServer((_q, res) => res.end("<html>hello</html>"));
  await new Promise<void>((r) => notPlex.listen(0, "127.0.0.1", r));
  const bad = (await test(`http://127.0.0.1:${(notPlex.address() as AddressInfo).port}`)).json() as AdminTestResult;
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /doesn't look like a Plex server/);
  notPlex.closeAllConnections();
  notPlex.close();

  const dead = await new FakePlex().start();
  const deadUrl = dead.url;
  await dead.stop();
  const down = (await test(deadUrl)).json() as AdminTestResult;
  assert.match(down.error!, /Couldn't reach/);
  assert.deepEqual((await t.app.inject({ method: "GET", url: "/api/admin/plex", headers: t.admin })).json(), { serverUrl: t.fake.url, source: "admin" });
  await finish(t);
});