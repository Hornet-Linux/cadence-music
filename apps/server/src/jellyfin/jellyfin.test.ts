import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type {
  AdminJellyfinResponse,
  AdminJellyfinTestResponse,
  AuthResponse,
  JellyfinAlbumsResponse,
  JellyfinMatchResponse,
  JellyfinPlaylistsResponse,
  JellyfinStatusResponse,
  JellyfinStreamUrlResponse,
  JellyfinTasteResponse,
  JellyfinTracksResponse,
} from "@uma/shared";
import { buildApp } from "../app.js";
import { createLocalUser } from "../auth/users.js";
import type { Config } from "../config.js";
import { openDb, type Db } from "../db.js";
import { open } from "../llm/secretBox.js";
import { FakeJellyfin, hex, IDS, PAYLOAD } from "./fakeJellyfin.js";
import { createJellyfinPlugin, type JellyfinPluginOptions } from "./plugin.js";

const SECRET = "s".repeat(64);
const GOOD = { username: "tester", password: "jellyfin-test-pass" };

async function setup(opts: { fake?: FakeJellyfin | null; env?: boolean; plugin?: JellyfinPluginOptions; extraUsers?: string[] } = {}) {
  const fake = opts.fake === null ? null : (opts.fake ?? (await new FakeJellyfin().start()));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-jf-"));
  const db = openDb(":memory:");
  await createLocalUser(db, { username: "admin", password: "admin-password", isAdmin: true });
  await createLocalUser(db, { username: "alice", password: "alice-password" });
  await createLocalUser(db, { username: "bob", password: "bob-password" });
  for (const u of opts.extraUsers ?? []) await createLocalUser(db, { username: u, password: `${u}-password` });
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    musicDir: dir,
    scanIntervalMinutes: 0,
    trustProxy: false,
    logLevel: "silent",
    ...(opts.env && fake ? { jellyfinUrl: fake.url } : {}),
  };
  const app = await buildApp({ config, db, secret: SECRET, logger: false, plugins: [createJellyfinPlugin(opts.plugin)] });
  const signIn = async (username: string) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: `${username}-password` } });
    return { authorization: `Bearer ${(res.json() as AuthResponse).token}` };
  };
  const admin = await signIn("admin");
  // Most tests want Jellyfin configured and a person signed in to it.
  if (fake && !opts.env) {
    await app.inject({ method: "PUT", url: "/api/admin/jellyfin", headers: admin, payload: { serverUrl: fake.url } });
  }
  const connect = async (headers: { authorization: string }, body: object = GOOD) =>
    app.inject({ method: "PUT", url: "/api/jellyfin/connection", headers, payload: body });
  const result = { app, db, fake: fake as FakeJellyfin, admin, alice: await signIn("alice"), bob: await signIn("bob"), signIn, connect };
  return result;
}

const get = (t: Awaited<ReturnType<typeof setup>>, url: string, who: { authorization: string }) =>
  t.app.inject({ method: "GET", url, headers: who });

async function streamPath(t: Awaited<ReturnType<typeof setup>>, id: string, who: { authorization: string }): Promise<string> {
  const res = await get(t, `/api/jellyfin/tracks/${id}/stream-url`, who);
  assert.equal(res.statusCode, 200, res.body);
  return `/${(res.json() as JellyfinStreamUrlResponse).path}`;
}

async function finish(t: Awaited<ReturnType<typeof setup>>) {
  await t.app.close();
  await t.fake?.stop();
}

function connectionRows(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM jellyfin_connections").get() as { n: number }).n;
}

function storedToken(db: Db, user: string): string | undefined {
  const row = db.prepare("SELECT c.token_enc FROM jellyfin_connections c JOIN users u ON u.id = c.user_id WHERE u.username = ?").get(user) as
    | { token_enc: string }
    | undefined;
  return row && (open(row.token_enc, SECRET, "jellyfin-access-tokens") ?? undefined);
}

// ---- sign-in -------------------------------------------------------------------

test("sign-in: token encrypted at rest, never returned, password never stored", async () => {
  const t = await setup();
  assert.deepEqual((await get(t, "/api/jellyfin/status", t.alice)).json(), { configured: true, connected: false });

  const bad = await t.connect(t.alice, { username: "tester", password: "wrong-password" });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.json().error, "jellyfin_invalid_credentials");
  assert.ok(!bad.body.includes("unauthorized"), "no upstream text");

  const ok = await t.connect(t.alice);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json() as JellyfinStatusResponse, { configured: true, connected: true, serverName: "Fake Jelly", userName: "tester" });
  const token = [...t.fake.tokens][0];
  assert.ok(token);
  assert.ok(!ok.body.includes(token));
  assert.ok(!(await get(t, "/api/jellyfin/status", t.alice)).body.includes(token));

  const dump = JSON.stringify(t.db.prepare("SELECT * FROM jellyfin_connections").all());
  assert.ok(!dump.includes(token), "token is encrypted at rest");
  assert.ok(!dump.includes("jellyfin-test-pass"), "password is never stored");
  assert.equal(storedToken(t.db, "alice"), token);
  assert.equal(open((t.db.prepare("SELECT token_enc FROM jellyfin_connections").get() as { token_enc: string }).token_enc, SECRET), null, "not readable as an LLM key");

  // The calls follow Jellyfin 12's rules and identify Cadence.
  const login = t.fake.callsTo("/Users/AuthenticateByName")[1]; // [0] was the wrong password
  assert.match(String(login.headers.authorization), /^MediaBrowser Client="Cadence", Device="Cadence server", DeviceId="cadence-\d+-[0-9a-f]+", Version="[\d.]+"$/);
  assert.match(String(login.headers["user-agent"]), /^Cadence-Server\//);
  assert.deepEqual(login.body, { Username: "tester", Pw: "jellyfin-test-pass" });
  const deviceId = /DeviceId="([^"]+)"/.exec(String(login.headers.authorization))![1];

  // Signing in again keeps the same device, and signs the old token out.
  assert.equal((await t.connect(t.alice)).statusCode, 200);
  const logins = t.fake.callsTo("/Users/AuthenticateByName");
  assert.equal(/DeviceId="([^"]+)"/.exec(String(logins[2].headers.authorization))![1], deviceId);
  assert.equal(t.fake.callsTo("/Sessions/Logout").length, 1);
  assert.notEqual(storedToken(t.db, "alice"), token);

  // Disconnecting signs out in Jellyfin and forgets the token.
  const before = t.fake.tokens.size;
  assert.equal((await t.app.inject({ method: "DELETE", url: "/api/jellyfin/connection", headers: t.alice })).statusCode, 204);
  assert.equal(t.fake.tokens.size, before - 1);
  assert.deepEqual((await get(t, "/api/jellyfin/status", t.alice)).json(), { configured: true, connected: false });
  assert.equal(connectionRows(t.db), 0);
  assert.equal((await get(t, "/api/jellyfin/tracks", t.alice)).json().error, "jellyfin_not_connected");
  await finish(t);
});

test("sign-in: unreachable Jellyfin is a generic 502; not configured is 409", async () => {
  const t = await setup({ fake: null });
  assert.deepEqual((await get(t, "/api/jellyfin/status", t.alice)).json(), { configured: false, connected: false });
  assert.equal((await t.connect(t.alice)).json().error, "jellyfin_not_configured");

  const dead = await new FakeJellyfin().start();
  const deadUrl = dead.url;
  await dead.stop();
  await t.app.inject({ method: "PUT", url: "/api/admin/jellyfin", headers: t.admin, payload: { serverUrl: deadUrl } });
  const res = await t.connect(t.alice);
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, "jellyfin_failed");
  assert.ok(!res.body.includes("127.0.0.1") && !res.body.includes("ECONNREFUSED"), "no network details");
  await t.app.close();
});

test("sign-in rejects malformed bodies", async () => {
  const t = await setup();
  for (const body of [{}, { username: "", password: "x" }, { username: "tester" }, { username: 5, password: "x" }, { username: "tester", password: 7 }, { username: "x".repeat(300), password: "x" }]) {
    assert.equal((await t.connect(t.alice, body)).statusCode, 400, JSON.stringify(body));
  }
  assert.equal(t.fake.callsTo("/Users/AuthenticateByName").length, 0);
  await finish(t);
});

test("every route needs a signed-in Cadence user (except the signed stream and image URLs)", async () => {
  const t = await setup();
  const routes: [string, string][] = [
    ["GET", "/api/jellyfin/status"],
    ["PUT", "/api/jellyfin/connection"],
    ["DELETE", "/api/jellyfin/connection"],
    ["GET", "/api/jellyfin/tracks"],
    ["GET", "/api/jellyfin/albums"],
    ["GET", `/api/jellyfin/albums/${IDS.cross}/tracks`],
    ["GET", "/api/jellyfin/playlists"],
    ["GET", `/api/jellyfin/playlists/${IDS.playlist}/tracks`],
    ["PUT", `/api/jellyfin/favourites/${IDS.dance}`],
    ["DELETE", `/api/jellyfin/favourites/${IDS.dance}`],
    ["POST", "/api/jellyfin/match"],
    ["GET", "/api/jellyfin/taste"],
    ["GET", `/api/jellyfin/tracks/${IDS.dance}/stream-url`],
    ["POST", "/api/jellyfin/playback"],
    ["GET", "/api/admin/jellyfin"],
    ["PUT", "/api/admin/jellyfin"],
    ["POST", "/api/admin/jellyfin/test"],
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

// ---- no user-supplied addresses ----------------------------------------------------

test("people cannot point the server anywhere: the address is the owner's alone", async () => {
  const t = await setup();
  const evil = await new FakeJellyfin().start();
  const smuggled = { ...GOOD, serverUrl: evil.url, url: evil.url, baseUrl: evil.url, host: evil.url };
  assert.equal((await t.connect(t.alice, smuggled)).statusCode, 200);
  const q = `serverUrl=${encodeURIComponent(evil.url)}&url=${encodeURIComponent(evil.url)}&baseUrl=${encodeURIComponent(evil.url)}`;
  for (const url of ["/api/jellyfin/status", "/api/jellyfin/tracks", "/api/jellyfin/albums", "/api/jellyfin/playlists", "/api/jellyfin/taste"]) {
    await get(t, `${url}?${q}`, t.alice);
  }
  const sp = await streamPath(t, IDS.dance, t.alice);
  await t.app.inject({ method: "GET", url: `${sp}&${q}` });
  await t.app.inject({ method: "POST", url: "/api/jellyfin/match", headers: t.alice, payload: { picks: [{ artist: "Justice", title: "D.A.N.C.E.", serverUrl: evil.url }], serverUrl: evil.url } });
  // Ordinary users cannot use the admin settings either.
  assert.equal((await t.app.inject({ method: "PUT", url: "/api/admin/jellyfin", headers: t.alice, payload: { serverUrl: evil.url } })).statusCode, 403);
  assert.equal((await t.app.inject({ method: "POST", url: "/api/admin/jellyfin/test", headers: t.alice, payload: { serverUrl: evil.url } })).statusCode, 403);
  assert.equal(evil.calls.length, 0, "the attacker's server was never contacted");
  assert.ok(t.fake.calls.length > 5);
  await evil.stop();
  await finish(t);
});

test("ids that go into Jellyfin URLs must be 32 hex characters", async () => {
  const t = await setup();
  await t.connect(t.alice);
  const callsBefore = t.fake.calls.length;
  // (A bare ".." or "%2e%2e" never reaches the router: the URL parser resolves it as a path segment first.)
  const bad = [ "..%2fUsers", "..%2F..%2FSystem%2FInfo", "abc", "g".repeat(32), `${hex(1)}x`, `${hex(1)}%2f..`, "1".repeat(31), "%00", "a%20b"];
  for (const id of bad) {
    for (const [method, url] of [
      ["GET", `/api/jellyfin/albums/${id}/tracks`],
      ["GET", `/api/jellyfin/playlists/${id}/tracks`],
      ["PUT", `/api/jellyfin/favourites/${id}`],
      ["DELETE", `/api/jellyfin/favourites/${id}`],
      ["GET", `/api/jellyfin/tracks/${id}/stream-url`],
    ] as const) {
      const res = await t.app.inject({ method, url, headers: t.alice });
      assert.ok(res.statusCode === 400 || res.statusCode === 404, `${method} ${url} -> ${res.statusCode}`);
      assert.notEqual(res.statusCode, 200);
    }
    const res = await t.app.inject({ method: "GET", url: `/api/jellyfin/tracks?albumId=${id}`, headers: t.alice });
    assert.ok(res.statusCode === 400, `albumId ${id}`);
  }
  assert.equal((await t.app.inject({ method: "POST", url: "/api/jellyfin/playback", headers: t.alice, payload: { event: "start", itemId: "../Sessions", positionSec: 0 } })).statusCode, 400);
  // The signed routes validate ids as well, before anything else.
  assert.equal((await t.app.inject({ method: "GET", url: "/api/jellyfin/stream/..%2Fx?u=1&exp=1&sig=x" })).statusCode, 400);
  assert.equal((await t.app.inject({ method: "GET", url: "/api/jellyfin/image/abc?u=1&exp=1&sig=x" })).statusCode, 400);
  assert.equal(t.fake.calls.length, callsBefore, "nothing reached Jellyfin");
  await finish(t);
});

// ---- browsing ---------------------------------------------------------------------

test("tracks, albums and playlists are mapped, with signed relative artwork paths", async () => {
  const t = await setup();
  await t.connect(t.alice);
  t.fake.favourites.add(IDS.dance);

  const all = (await get(t, "/api/jellyfin/tracks", t.alice)).json() as JellyfinTracksResponse;
  assert.equal(all.total, 6);
  const dance = all.items.find((i) => i.id === IDS.dance)!;
  assert.deepEqual({ ...dance, artwork: undefined }, {
    id: IDS.dance,
    title: "D.A.N.C.E.",
    artists: ["Justice"],
    album: "Cross",
    albumId: IDS.cross,
    durationSec: 8,
    trackNo: 2,
    year: 2001,
    artwork: undefined,
    favourite: true,
  });
  assert.match(dance.artwork!, new RegExp(`^api/jellyfin/image/${IDS.dance}\\?u=\\d+&exp=\\d+&sig=[\\w-]+$`), "own picture");
  const one = all.items.find((i) => i.id === IDS.oneMoreTime)!;
  assert.match(one.artwork!, new RegExp(`^api/jellyfin/image/${IDS.discovery}\\?`), "falls back to the album's picture");
  assert.equal(one.favourite, false);
  assert.equal(all.items.find((i) => i.id === IDS.stall)!.artwork, undefined, "no picture, no artwork");

  // Query parameters are forwarded as Jellyfin's own.
  await get(t, "/api/jellyfin/tracks?q=lucky&limit=9999&offset=3&artist=Daft%20Punk&album=Random%20Access%20Memories", t.alice);
  const last = t.fake.callsTo("/Items").at(-1)!;
  assert.equal(last.query.SearchTerm, "lucky");
  assert.equal(last.query.Limit, "500", "limit is clamped");
  assert.equal(last.query.StartIndex, "3");
  assert.equal(last.query.Artists, "Daft Punk");
  assert.equal(last.query.Albums, "Random Access Memories");
  assert.equal(last.query.userId, hex(7000));
  assert.equal(last.query.IncludeItemTypes, "Audio");
  const lucky = (await get(t, "/api/jellyfin/tracks?q=lucky", t.alice)).json() as JellyfinTracksResponse;
  assert.deepEqual(lucky.items.map((i) => i.title), ["Get Lucky"]);

  const favs = (await get(t, "/api/jellyfin/tracks?favourites=1", t.alice)).json() as JellyfinTracksResponse;
  assert.deepEqual(favs.items.map((i) => i.id), [IDS.dance]);
  const inAlbum = (await get(t, `/api/jellyfin/tracks?albumId=${IDS.ram.toUpperCase()}`, t.alice)).json() as JellyfinTracksResponse;
  assert.equal(inAlbum.total, 2);
  assert.equal((await get(t, "/api/jellyfin/tracks?limit=0", t.alice)).statusCode, 200);

  const albums = (await get(t, "/api/jellyfin/albums?artist=Justice", t.alice)).json() as JellyfinAlbumsResponse;
  assert.equal(albums.total, 1);
  assert.deepEqual({ ...albums.items[0], artwork: undefined }, { id: IDS.cross, name: "Cross", artist: "Justice", year: 2007, trackCount: 1, artwork: undefined });
  const albumTracks = (await get(t, `/api/jellyfin/albums/${IDS.ram}/tracks`, t.alice)).json() as JellyfinTracksResponse;
  assert.deepEqual(albumTracks.items.map((i) => i.title), ["Get Lucky", "Instant Crush (feat. Julian Casablancas)"]);

  const lists = (await get(t, "/api/jellyfin/playlists", t.alice)).json() as JellyfinPlaylistsResponse;
  assert.deepEqual(lists.items, [{ id: IDS.playlist, name: "Night drive", trackCount: 2 }]);
  const listTracks = (await get(t, `/api/jellyfin/playlists/${IDS.playlist}/tracks`, t.alice)).json() as JellyfinTracksResponse;
  assert.deepEqual(listTracks.items.map((i) => i.title), ["One More Time", "D.A.N.C.E."]);
  await finish(t);
});

test("a Jellyfin 401 drops the stale connection and asks the person to sign in again", async () => {
  const t = await setup();
  await t.connect(t.alice);
  t.fake.tokens.clear(); // revoked in Jellyfin
  const res = await get(t, "/api/jellyfin/tracks", t.alice);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "jellyfin_session_expired");
  assert.deepEqual((await get(t, "/api/jellyfin/status", t.alice)).json(), { configured: true, connected: false });
  assert.equal(connectionRows(t.db), 0);
  await finish(t);
});

test("clients never see upstream text or network details", async () => {
  const t = await setup();
  await t.connect(t.alice);
  t.fake.failWith = "SECRET-UPSTREAM-DETAIL at C:\\jellyfin\\db";
  for (const url of ["/api/jellyfin/tracks", "/api/jellyfin/albums", "/api/jellyfin/playlists", "/api/jellyfin/taste", `/api/jellyfin/tracks/${IDS.dance}/stream-url`]) {
    const res = await get(t, url, t.alice);
    assert.equal(res.statusCode, 502, url);
    assert.equal(res.json().error, "jellyfin_failed");
    assert.ok(!/SECRET|jellyfin\\|127\.0\.0\.1/.test(res.body), res.body);
  }
  // The connection survives a Jellyfin outage.
  assert.equal(((await get(t, "/api/jellyfin/status", t.alice)).json() as JellyfinStatusResponse).connected, true);
  await finish(t);
});

test("redirects to another address are not followed (the sign-in token would go with them)", async () => {
  const t = await setup();
  await t.connect(t.alice);
  const elsewhere = await new FakeJellyfin().start();
  t.fake.redirectTo = elsewhere.url;
  const res = await get(t, "/api/jellyfin/tracks", t.alice);
  assert.equal(res.statusCode, 502);
  assert.equal(elsewhere.calls.length, 0);
  await elsewhere.stop();
  await finish(t);
});

// ---- favourites and playback -----------------------------------------------------------

test("favourites: add and remove in the person's own Jellyfin", async () => {
  const t = await setup();
  await t.connect(t.alice);
  assert.equal((await t.app.inject({ method: "PUT", url: `/api/jellyfin/favourites/${IDS.dance.toUpperCase()}`, headers: t.alice })).statusCode, 204);
  assert.ok(t.fake.favourites.has(IDS.dance));
  const call = t.fake.callsTo(`/UserFavoriteItems/${IDS.dance}`)[0];
  assert.equal(call.method, "POST");
  assert.equal(call.query.userId, hex(7000));
  assert.equal((await t.app.inject({ method: "DELETE", url: `/api/jellyfin/favourites/${IDS.dance}`, headers: t.alice })).statusCode, 204);
  assert.ok(!t.fake.favourites.has(IDS.dance));
  assert.equal(t.fake.callsTo(`/UserFavoriteItems/${IDS.dance}`)[1].method, "DELETE");
  await finish(t);
});

test("favourites: falls back to the per-user route on older Jellyfin", async () => {
  const t = await setup();
  await t.connect(t.alice);
  t.fake.legacyFavouritesOnly = true;
  assert.equal((await t.app.inject({ method: "PUT", url: `/api/jellyfin/favourites/${IDS.dance}`, headers: t.alice })).statusCode, 204);
  assert.ok(t.fake.favourites.has(IDS.dance));
  assert.equal(t.fake.callsTo(`/Users/${hex(7000)}/FavoriteItems/${IDS.dance}`).length, 1);
  await finish(t);
});

test("playback reports map to Jellyfin's session calls with ticks", async () => {
  const t = await setup();
  await t.connect(t.alice);
  const send = (payload: object) => t.app.inject({ method: "POST", url: "/api/jellyfin/playback", headers: t.alice, payload });
  assert.equal((await send({ event: "start", itemId: IDS.dance, positionSec: 0 })).statusCode, 204);
  assert.equal((await send({ event: "progress", itemId: IDS.dance, positionSec: 12.5 })).statusCode, 204);
  assert.equal((await send({ event: "stop", itemId: IDS.dance, positionSec: 200 })).statusCode, 204);
  const start = t.fake.callsTo("/Sessions/Playing")[0];
  assert.equal(start.method, "POST");
  assert.equal((start.body as { ItemId: string }).ItemId, IDS.dance);
  assert.equal((start.body as { PositionTicks: number }).PositionTicks, 0);
  assert.equal((t.fake.callsTo("/Sessions/Playing/Progress")[0].body as { PositionTicks: number }).PositionTicks, 125_000_000);
  assert.equal((t.fake.callsTo("/Sessions/Playing/Stopped")[0].body as { PositionTicks: number }).PositionTicks, 2_000_000_000);
  assert.equal(t.fake.plays.get(IDS.dance), 1);

  for (const payload of [{}, { event: "pause", itemId: IDS.dance, positionSec: 1 }, { event: "start", itemId: IDS.dance, positionSec: -1 }, { event: "start", itemId: IDS.dance, positionSec: "1" }, { event: "start", itemId: "x", positionSec: 1 }, { event: "toString", itemId: IDS.dance, positionSec: 1 }]) {
    assert.equal((await send(payload)).statusCode, 400, JSON.stringify(payload));
  }
  // Best effort: a failing Jellyfin doesn't make the app's player complain.
  t.fake.failWith = "boom";
  assert.equal((await send({ event: "progress", itemId: IDS.dance, positionSec: 3 })).statusCode, 204);
  await finish(t);
});

// ---- matching -----------------------------------------------------------------------------

test("match: finds library tracks by artist and title, tolerating noise, null otherwise", async () => {
  const t = await setup();
  await t.connect(t.alice);
  const picks = [
    { artist: "Daft Punk", title: "One More Time" },
    { artist: "daft punk", title: "ONE MORE TIME (Remastered 2011)" },
    { artist: "Justice", title: "DANCE" }, // punctuation hides it from Jellyfin's title search; found through the artist
    { artist: "Daft Punk feat. Julian Casablancas", title: "Instant Crush" },
    { artist: "Daft Punk", title: "Instant Crush - Remastered" },
    { artist: "Daft Punk", title: "Doesn't Exist" },
    { artist: "Somebody Else", title: "Get Lucky" }, // right title, wrong artist
    { artist: "", title: "Get Lucky" },
  ];
  const res = await t.app.inject({ method: "POST", url: "/api/jellyfin/match", headers: t.alice, payload: { picks } });
  assert.equal(res.statusCode, 200, res.body);
  const { matches } = res.json() as JellyfinMatchResponse;
  assert.deepEqual(matches.map((m) => m?.id ?? null), [IDS.oneMoreTime, IDS.oneMoreTime, IDS.dance, IDS.instantCrush, IDS.instantCrush, null, null, null]);
  assert.equal(matches[0]!.favourite, false);
  assert.ok(matches[0]!.artwork);

  assert.equal((await t.app.inject({ method: "POST", url: "/api/jellyfin/match", headers: t.alice, payload: { picks: [] } })).json().matches.length, 0);
  const many = Array.from({ length: 31 }, () => ({ artist: "a", title: "b" }));
  for (const body of [{ picks: many }, { picks: "x" }, {}, { picks: [{ artist: 1, title: "x" }] }, { picks: [null] }]) {
    assert.equal((await t.app.inject({ method: "POST", url: "/api/jellyfin/match", headers: t.alice, payload: body })).statusCode, 400);
  }
  const thirty = Array.from({ length: 30 }, () => ({ artist: "Daft Punk", title: "Get Lucky" }));
  const big = await t.app.inject({ method: "POST", url: "/api/jellyfin/match", headers: t.alice, payload: { picks: thirty } });
  assert.equal((big.json() as JellyfinMatchResponse).matches.length, 30);
  await finish(t);
});

// ---- taste ----------------------------------------------------------------------------------

test("taste: built from plays and favourites, falling back to the library for a new Jellyfin", async () => {
  const t = await setup();
  await t.connect(t.alice);

  // A new Jellyfin: no plays, no favourites. Describe the library so the DJ still works.
  const fresh = (await get(t, "/api/jellyfin/taste", t.alice)).json() as JellyfinTasteResponse;
  assert.ok(fresh.topArtists.includes("Daft Punk") && fresh.topArtists.includes("Justice"));
  assert.ok(fresh.genres.includes("electronic"));
  assert.ok(fresh.topTracks.includes("Justice – D.A.N.C.E."));
  assert.deepEqual(fresh.recentTracks, []);

  t.fake.plays.set(IDS.dance, 5);
  t.fake.plays.set(IDS.getLucky, 2);
  t.fake.favourites.add(IDS.oneMoreTime);
  const taste = (await get(t, "/api/jellyfin/taste", t.alice)).json() as JellyfinTasteResponse;
  assert.deepEqual(taste.topArtists.slice(0, 2), ["Justice", "Daft Punk"], "most played first");
  assert.deepEqual(taste.topTracks, ["Justice – D.A.N.C.E.", "Daft Punk – Get Lucky"]);
  assert.deepEqual(taste.recentTracks.sort(), ["Daft Punk – Get Lucky", "Justice – D.A.N.C.E."]);
  assert.equal(taste.genres[0], "electronic");

  // Only favourites: the DJ has something to go on.
  t.fake.plays.clear();
  const favOnly = (await get(t, "/api/jellyfin/taste", t.alice)).json() as JellyfinTasteResponse;
  assert.deepEqual(favOnly.topTracks, ["Daft Punk – One More Time"]);
  assert.ok(favOnly.topArtists.length > 0);
  await finish(t);
});

// ---- signed streams and images --------------------------------------------------------------

test("stream: signed URL, whole file and ranges are passed through", async () => {
  const t = await setup();
  await t.connect(t.alice);
  const url = await streamPath(t, IDS.dance, t.alice);
  assert.match(url, new RegExp(`^/api/jellyfin/stream/${IDS.dance}\\?u=\\d+&exp=\\d+&sig=`));
  const { expiresAt } = (await get(t, `/api/jellyfin/tracks/${IDS.dance}/stream-url`, t.alice)).json() as JellyfinStreamUrlResponse;
  assert.ok(Math.abs(expiresAt - (Date.now() / 1000 + 6 * 3600)) < 30, "six hours");

  // No bearer header: the signature is the credential.
  const whole = await t.app.inject({ method: "GET", url });
  assert.equal(whole.statusCode, 200);
  assert.equal(whole.headers["content-type"], "audio/flac");
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
  assert.equal(t.fake.callsTo(/universal/).at(-1)!.headers.range, undefined);

  // What Jellyfin was asked for: a browser-safe format, the person's own sign-in, no redirects.
  const upstream = t.fake.callsTo(`/Audio/${IDS.dance}/universal`)[0];
  assert.match(upstream.query.container, /\bmp3\b.*\bflac\b/);
  assert.equal(upstream.query.transcodingContainer, "mp3");
  assert.equal(upstream.query.userId, hex(7000));
  assert.equal(upstream.query.enableRedirection, "false");
  assert.match(String(upstream.headers.authorization), /Token="token-tester-/);
  assert.match(String(upstream.headers["user-agent"]), /^Cadence-Server\//);
  await finish(t);
});

test("stream and image URLs: bad, expired, other-user and cross-kind signatures are refused", async () => {
  const t = await setup();
  await t.connect(t.alice);
  const stream = await streamPath(t, IDS.dance, t.alice);
  const callsBefore = t.fake.calls.length;
  const u = new URL(stream, "http://x");
  const q = (patch: Record<string, string>) => {
    const p = new URLSearchParams(u.search);
    for (const [k, v] of Object.entries(patch)) p.set(k, v);
    return p.toString();
  };
  const bobId = (t.db.prepare("SELECT id FROM users WHERE username = 'bob'").get() as { id: number }).id;
  for (const [name, url] of Object.entries({
    badSig: `${u.pathname}?${q({ sig: "AAAA" })}`,
    noSig: `${u.pathname}?u=1&exp=${u.searchParams.get("exp")}`,
    expired: `${u.pathname}?${q({ exp: "1000" })}`,
    otherUser: `${u.pathname}?${q({ u: String(bobId) })}`,
    otherItem: `/api/jellyfin/stream/${IDS.getLucky}?${u.searchParams}`,
    asImage: `/api/jellyfin/image/${IDS.dance}?${u.searchParams}`,
    noQuery: u.pathname,
  })) {
    const res = await t.app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 403, name);
  }
  assert.equal(t.fake.calls.length, callsBefore);

  // The artwork URLs from a listing work as given, with a width.
  const tracks = (await get(t, "/api/jellyfin/tracks?q=D.A.N.C.E.", t.alice)).json() as JellyfinTracksResponse;
  const art = `/${tracks.items[0].artwork}`;
  const img = await t.app.inject({ method: "GET", url: `${art}&w=64` });
  assert.equal(img.statusCode, 200);
  assert.equal(img.headers["content-type"], "image/jpeg");
  assert.match(String(img.headers["cache-control"]), /max-age=\d{6,}/);
  assert.equal(t.fake.callsTo(/Images\/Primary/).at(-1)!.query.maxWidth, "64");
  await t.app.inject({ method: "GET", url: art });
  assert.equal(t.fake.callsTo(/Images\/Primary/).at(-1)!.query.maxWidth, "300", "default width");
  await t.app.inject({ method: "GET", url: `${art}&w=99999` });
  assert.equal(t.fake.callsTo(/Images\/Primary/).at(-1)!.query.maxWidth, "1200", "clamped");
  await t.app.inject({ method: "GET", url: `${art}&w=-4` });
  assert.equal(t.fake.callsTo(/Images\/Primary/).at(-1)!.query.maxWidth, "16");
  assert.equal((await t.app.inject({ method: "GET", url: `${art.replace("sig=", "sig=x")}` })).statusCode, 403);
  // Once the person signs out, their old URLs stop working.
  await t.app.inject({ method: "DELETE", url: "/api/jellyfin/connection", headers: t.alice });
  assert.equal((await t.app.inject({ method: "GET", url: stream })).statusCode, 401);
  await finish(t);
});

test("stream-url: unknown tracks are 404; people only get their own sign-in's access", async () => {
  const t = await setup();
  await t.connect(t.alice);
  assert.equal((await get(t, `/api/jellyfin/tracks/${hex(12345)}/stream-url`, t.alice)).statusCode, 404);
  // Bob is not signed in to Jellyfin: Alice's URL, or any other, gives him nothing.
  assert.equal((await get(t, `/api/jellyfin/tracks/${IDS.dance}/stream-url`, t.bob)).json().error, "jellyfin_not_connected");
  const aliceUrl = await streamPath(t, IDS.dance, t.alice);
  assert.equal((await t.app.inject({ method: "GET", url: aliceUrl })).statusCode, 200);

  // Two people, two Jellyfin accounts, each call carries its owner's token.
  assert.equal((await t.connect(t.bob, { username: "other", password: "other-pass" })).statusCode, 200);
  const bobUrl = await streamPath(t, IDS.getLucky, t.bob);
  await t.app.inject({ method: "GET", url: bobUrl });
  await t.app.inject({ method: "GET", url: aliceUrl });
  const bobCall = t.fake.callsTo(`/Audio/${IDS.getLucky}/universal`).at(-1)!;
  const aliceCall = t.fake.callsTo(`/Audio/${IDS.dance}/universal`).at(-1)!;
  assert.match(String(bobCall.headers.authorization), /Token="token-other-/);
  assert.equal(bobCall.query.userId, hex(7001));
  assert.match(String(aliceCall.headers.authorization), /Token="token-tester-/);
  assert.notEqual(storedToken(t.db, "alice"), storedToken(t.db, "bob"));
  // Bob's connection and Alice's are independent.
  await t.app.inject({ method: "DELETE", url: "/api/jellyfin/connection", headers: t.bob });
  assert.equal((await t.app.inject({ method: "GET", url: aliceUrl })).statusCode, 200);
  assert.equal((await t.app.inject({ method: "GET", url: bobUrl })).statusCode, 401);
  await finish(t);
});

async function listen(t: Awaited<ReturnType<typeof setup>>): Promise<string> {
  await t.app.listen({ port: 0, host: "127.0.0.1" });
  return `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
}

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return check();
};

test("stream: when the client goes away the request to Jellyfin is cancelled", async () => {
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
  assert.ok(await until(() => t.fake.aborted.includes(IDS.endless)), "Jellyfin saw the request end");
  await finish(t);
});

test("stream: a Jellyfin that stops sending is cut off", async () => {
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
  const hang = http.createServer(() => undefined);
  await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
  const hangUrl = `http://127.0.0.1:${(hang.address() as AddressInfo).port}`;
  // Sign in at a real fake, then have the owner re-point to the hanging server with a connection stored for it.
  const fake = await new FakeJellyfin().start();
  const t = await setup({ fake, plugin: { streamHeaderTimeoutMs: 150 } });
  await t.connect(t.alice);
  const url = await streamPath(t, IDS.dance, t.alice);
  t.db.prepare("UPDATE jellyfin_connections SET server_url = ?").run(hangUrl);
  t.db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('jellyfin:serverUrl', ?, 0)").run(JSON.stringify(hangUrl));
  const res = await t.app.inject({ method: "GET", url });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().message, "Jellyfin took too long to answer");
  hang.closeAllConnections();
  hang.close();
  await finish(t);
});

// ---- rate limits ------------------------------------------------------------------------------

test("sign-in attempts are limited per person, so Cadence can't be used to guess Jellyfin passwords", async () => {
  const t = await setup();
  const wrong = { username: "tester", password: "guess" };
  for (let i = 0; i < 5; i++) assert.equal((await t.connect(t.alice, wrong)).statusCode, 401);
  const limited = await t.connect(t.alice, wrong);
  assert.equal(limited.statusCode, 429);
  // Even the right password waits, and Jellyfin isn't asked.
  const asked = t.fake.callsTo("/Users/AuthenticateByName").length;
  assert.equal((await t.connect(t.alice)).statusCode, 429);
  assert.equal(t.fake.callsTo("/Users/AuthenticateByName").length, asked);
  // Someone else on another account is unaffected (until the address limit).
  assert.equal((await t.connect(t.bob)).statusCode, 200);
  await finish(t);
});

test("sign-in attempts are also limited per address across accounts", async () => {
  const t = await setup({ extraUsers: ["carol", "dave", "erin", "frank"] });
  const wrong = { username: "tester", password: "guess" };
  for (const name of ["alice", "bob", "carol", "dave"]) {
    const who = await t.signIn(name);
    for (let i = 0; i < 5; i++) assert.equal((await t.connect(who, wrong)).statusCode, 401, `${name} ${i}`);
  }
  const erin = await t.signIn("erin");
  assert.equal((await t.connect(erin, wrong)).statusCode, 429, "the address has used its attempts");
  assert.equal((await t.connect(erin)).statusCode, 429);
  await finish(t);
});

test("successful sign-ins and unreachable servers do not count against the limit", async () => {
  const t = await setup();
  for (let i = 0; i < 8; i++) assert.equal((await t.connect(t.alice)).statusCode, 200);
  await finish(t);
});

// ---- admin ----------------------------------------------------------------------------------------

test("admin: the address is validated, saved, and applies immediately", async () => {
  const t = await setup({ fake: null });
  const put = (serverUrl: unknown) => t.app.inject({ method: "PUT", url: "/api/admin/jellyfin", headers: t.admin, payload: { serverUrl } });
  assert.deepEqual((await t.app.inject({ method: "GET", url: "/api/admin/jellyfin", headers: t.admin })).json(), { serverUrl: null, source: null });

  for (const bad of ["jellyfin", "ftp://x", "http://u:p@host:8096", "http://host?x=1", "http://host#x", "javascript:alert(1)", 5, {}]) {
    assert.equal((await put(bad)).statusCode, 400, JSON.stringify(bad));
  }
  const saved = await put("http://jellyfin:8096/");
  assert.deepEqual(saved.json() as AdminJellyfinResponse, { serverUrl: "http://jellyfin:8096", source: "admin" });
  assert.deepEqual((await get(t, "/api/jellyfin/status", t.alice)).json(), { configured: true, connected: false });
  assert.deepEqual((await put(null)).json(), { serverUrl: null, source: null });
  assert.deepEqual((await get(t, "/api/jellyfin/status", t.alice)).json(), { configured: false, connected: false });
  assert.deepEqual((await put("")).json(), { serverUrl: null, source: null });
  await t.app.close();
});

test("admin: JELLYFIN_URL wins over the saved address", async () => {
  const t = await setup({ env: true });
  assert.deepEqual((await t.app.inject({ method: "GET", url: "/api/admin/jellyfin", headers: t.admin })).json(), { serverUrl: t.fake.url, source: "env" });
  const res = await t.app.inject({ method: "PUT", url: "/api/admin/jellyfin", headers: t.admin, payload: { serverUrl: "http://elsewhere:8096" } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "set_by_environment");
  assert.equal((await t.connect(t.alice)).statusCode, 200, "the environment's address is the one used");
  // Even a value that is in the database from before is ignored.
  t.db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('jellyfin:serverUrl', ?, 0)").run(JSON.stringify("http://elsewhere:8096"));
  assert.equal((await t.app.inject({ method: "GET", url: "/api/admin/jellyfin", headers: t.admin })).json().source, "env");
  assert.equal(((await get(t, "/api/jellyfin/status", t.alice)).json() as JellyfinStatusResponse).connected, true);
  await finish(t);
});

test("admin: a changed address never receives the old address's tokens", async () => {
  const t = await setup();
  await t.connect(t.alice);
  const other = await new FakeJellyfin().start();
  other.tokens.add("anything");
  await t.app.inject({ method: "PUT", url: "/api/admin/jellyfin", headers: t.admin, payload: { serverUrl: other.url } });
  const status = (await get(t, "/api/jellyfin/status", t.alice)).json() as JellyfinStatusResponse;
  assert.equal(status.connected, false);
  assert.equal((await get(t, "/api/jellyfin/tracks", t.alice)).statusCode, 409);
  await t.app.inject({ method: "DELETE", url: "/api/jellyfin/connection", headers: t.alice });
  assert.equal(other.calls.length, 0, "no token went to the new address");
  await other.stop();
  await finish(t);
});

test("admin: the test button checks an address without saving it", async () => {
  const t = await setup();
  const test = (serverUrl: unknown) => t.app.inject({ method: "POST", url: "/api/admin/jellyfin/test", headers: t.admin, payload: { serverUrl } });
  const ok = (await test(`${t.fake.url}/`)).json() as AdminJellyfinTestResponse;
  assert.deepEqual(ok, { ok: true, serverName: "Fake Jelly", version: "12.2.0" });
  assert.equal(t.fake.callsTo("/System/Info/Public").at(-1)!.headers.authorization?.includes("Token="), false, "no token is sent to an address being tested");
  assert.equal((await test("nonsense")).statusCode, 400);
  assert.equal((await test("http://u:p@host")).statusCode, 400);
  assert.equal((await test(undefined)).statusCode, 400);

  const notJelly = http.createServer((_q, res) => res.end("<html>hello</html>"));
  await new Promise<void>((r) => notJelly.listen(0, "127.0.0.1", r));
  const bad = (await test(`http://127.0.0.1:${(notJelly.address() as AddressInfo).port}`)).json() as AdminJellyfinTestResponse;
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /doesn't look like Jellyfin/);
  notJelly.close();

  const dead = await new FakeJellyfin().start();
  const deadUrl = dead.url;
  await dead.stop();
  const down = (await test(deadUrl)).json() as AdminJellyfinTestResponse;
  assert.equal(down.ok, false);
  assert.match(down.error!, /Couldn't reach/);
  assert.deepEqual((await t.app.inject({ method: "GET", url: "/api/admin/jellyfin", headers: t.admin })).json(), { serverUrl: t.fake.url, source: "admin" }, "testing doesn't save");

  const redirect = http.createServer((_q, res) => {
    res.writeHead(302, { Location: `${t.fake.url}/System/Info/Public` });
    res.end();
  });
  await new Promise<void>((r) => redirect.listen(0, "127.0.0.1", r));
  const moved = (await test(`http://127.0.0.1:${(redirect.address() as AddressInfo).port}`)).json() as AdminJellyfinTestResponse;
  assert.equal(moved.ok, false);
  assert.match(moved.error!, /redirects/);
  redirect.close();
  await finish(t);
});

test("the sign-in rows go when the person does", async () => {
  const t = await setup();
  await t.connect(t.alice);
  const id = (t.db.prepare("SELECT id FROM users WHERE username = 'alice'").get() as { id: number }).id;
  t.db.prepare("DELETE FROM users WHERE id = ?").run(id);
  assert.equal(connectionRows(t.db), 0);
  await finish(t);
});
