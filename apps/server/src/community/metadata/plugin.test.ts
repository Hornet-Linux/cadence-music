import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import type { AuthResponse } from "@uma/shared";
import { buildApp } from "../../app.js";
import { createLocalUser } from "../../auth/users.js";
import { openDb, type Db } from "../../db.js";
import createDefault, { createMetadataPlugin, METADATA_PLUGIN_ID, userAgent } from "./plugin.js";

const A = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const RG1 = "11111111-1111-4111-8111-111111111111";
const START = Date.parse("2026-10-22T12:00:00Z");
const clock = { t: START };

interface Call {
  url: string;
  headers: Record<string, string>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fakeWorld = (url: string): Response => {
  if (url.includes("musicbrainz.test/ws/2/artist?query=")) {
    return json({ artists: [{ id: A, name: "Radiohead", score: 100 }] });
  }
  if (url.includes("/ws/2/artist/" + A)) {
    return json({
      id: A,
      name: "Radiohead",
      type: "Group",
      country: "GB",
      "life-span": { begin: "1985" },
      genres: [{ name: "alternative rock", count: 9 }, { name: "art rock", count: 4 }],
      relations: [
        { type: "official homepage", url: { resource: "https://radiohead.com/" } },
        { type: "wikidata", url: { resource: "https://www.wikidata.org/wiki/Q44190" } },
        { type: "streaming", url: { resource: "javascript:alert(1)" } },
      ],
    });
  }
  if (url.includes("wikidata.test/w/api.php")) {
    return json({ entities: { Q44190: { sitelinks: { enwiki: { title: "Radiohead" } } } } });
  }
  if (url.includes("wikipedia.test/api/rest_v1/page/summary/Radiohead")) {
    return json({
      title: "Radiohead",
      description: "English rock band",
      extract: "Radiohead are an English rock band formed in Abingdon.",
      thumbnail: { source: "https://upload.wikimedia.org/x.jpg" },
      content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Radiohead" } },
    });
  }
  if (url.includes("release-group?query=")) {
    return json({
      "release-groups": [
        { id: RG1, title: "New One", "primary-type": "Album", "first-release-date": "2026-09-01", "artist-credit": [{ name: "Radiohead", artist: { id: A, name: "Radiohead" } }] },
        { id: "22222222-2222-4222-8222-222222222222", title: "Live Thing", "primary-type": "Album", "secondary-types": ["Live"], "first-release-date": "2026-09-05", "artist-credit": [{ name: "Radiohead" }] },
        { id: "33333333-3333-4333-8333-333333333333", title: "Cover By Others", "primary-type": "Single", "first-release-date": "2026-09-07", "artist-credit": [{ name: "Someone Else" }] },
      ],
    });
  }
  if (url.includes("fanart.test/v3/music/" + A)) {
    return json({ name: "Radiohead", artistthumb: [{ url: "http://assets.fanart.tv/t.jpg", likes: "3" }], artistbackground: [] });
  }
  if (url.includes("bandsintown.test/artists/")) {
    return json([
      { id: "1", datetime: "2026-12-01T20:00:00", venue: { name: "Hall", city: "London", country: "United Kingdom", latitude: "51.5", longitude: "-0.1" }, offers: [{ type: "Tickets", url: "https://tix.example/1" }], url: "https://bit.example/1", lineup: ["Radiohead"] },
      { id: "2", datetime: "2026-12-03T20:00:00", venue: { name: "Arena", city: "Paris", country: "France" }, offers: [], lineup: [] },
    ]);
  }
  return new Response("not in the fake world", { status: 404 });
};

async function setup(handler: (url: string, headers: Record<string, string>) => Response = fakeWorld) {
  clock.t = START;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-meta-"));
  const db: Db = openDb(":memory:");
  await createLocalUser(db, { username: "root", password: "root-password", isAdmin: true });
  await createLocalUser(db, { username: "user", password: "user-password" });
  const calls: Call[] = [];
  const plugin = createMetadataPlugin({
    fetchFn: async (url, init) => {
      calls.push({ url, headers: init?.headers ?? {} });
      return handler(url, init?.headers ?? {});
    },
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
  });
  const app: FastifyInstance = await buildApp({
    config: { host: "127.0.0.1", port: 0, dataDir: dir, musicDir: dir, scanIntervalMinutes: 0, trustProxy: false, logLevel: "silent" },
    db,
    secret: "s".repeat(64),
    logger: false,
    plugins: [plugin],
  });
  const signIn = async (username: string, password: string) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
    return { authorization: "Bearer " + (res.json() as AuthResponse).token };
  };
  const admin = await signIn("root", "root-password");
  const user = await signIn("user", "user-password");
  const configure = (body: unknown) => app.inject({ method: "PUT", url: "/api/metadata/config", headers: admin, payload: body as object });
  await configure({
    baseUrls: {
      musicbrainz: "http://musicbrainz.test",
      wikidata: "http://wikidata.test",
      wikipedia: "http://wikipedia.test",
      fanart: "http://fanart.test",
      bandsintown: "http://bandsintown.test",
      discogs: "http://discogs.test",
      coverart: "http://coverart.test",
    },
  });
  return { app, db, calls, admin, user, configure };
}

test("the module default is a server plugin with a stable id and a clear User-Agent", () => {
  assert.equal(createDefault.id, METADATA_PLUGIN_ID);
  assert.match(userAgent(), /^Cadence\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/Hornet-Linux\/cadence-music\)/);
});

test("lookups need a signed-in user, config needs an admin", async () => {
  const { app, user } = await setup();
  assert.equal((await app.inject({ method: "GET", url: "/api/metadata/status" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/metadata/config", headers: user })).statusCode, 403);
  assert.equal((await app.inject({ method: "PUT", url: "/api/metadata/config", headers: user, payload: {} })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: "/api/metadata/status", headers: user })).statusCode, 200);
});

test("artist lookup by name finds the id, maps genres and safe links, and sends the User-Agent", async () => {
  const { app, user, calls } = await setup();
  const res = await app.inject({ method: "GET", url: "/api/metadata/musicbrainz/artist?name=Radiohead", headers: user });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.mbid, A);
  assert.deepEqual(body.genres, ["alternative rock", "art rock"]);
  assert.deepEqual(body.links, [{ label: "Website", url: "https://radiohead.com/" }]);
  assert.equal(body.wikidataId, "Q44190");
  assert.equal(body.beginYear, 1985);
  assert.equal(calls.length, 2);
  for (const c of calls) assert.equal(c.headers["user-agent"], userAgent());
});

test("a repeated lookup is a cache hit and does not call the service again", async () => {
  const { app, user, calls } = await setup();
  const url = "/api/metadata/musicbrainz/artist?name=Radiohead";
  await app.inject({ method: "GET", url, headers: user });
  const before = calls.length;
  const again = await app.inject({ method: "GET", url, headers: user });
  assert.equal(again.statusCode, 200);
  assert.equal(calls.length, before);
});

test("a cached lookup is repeated once its time to live has passed", async () => {
  const { app, user, calls } = await setup();
  const url = "/api/metadata/musicbrainz/artist?name=Radiohead";
  await app.inject({ method: "GET", url, headers: user });
  clock.t += 8 * 86_400_000;
  await app.inject({ method: "GET", url, headers: user });
  assert.equal(calls.length, 4, "both upstream calls repeated after 8 days");
});

test("wikipedia summary follows musicbrainz to wikidata to the article", async () => {
  const { app, user } = await setup();
  const res = await app.inject({ method: "GET", url: "/api/metadata/wikipedia/artist?name=Radiohead", headers: user });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.title, "Radiohead");
  assert.match(body.extract, /English rock band/);
  assert.equal(body.image, "https://upload.wikimedia.org/x.jpg");
  assert.equal(body.url, "https://en.wikipedia.org/wiki/Radiohead");
});

test("keyed services answer not_configured (501) until the admin adds a key", async () => {
  const { app, user, configure } = await setup();
  for (const url of ["/api/metadata/fanart/artist?mbid=" + A, "/api/metadata/events/artist?name=Radiohead", "/api/metadata/discogs/artist?name=Radiohead"]) {
    const res = await app.inject({ method: "GET", url, headers: user });
    assert.equal(res.statusCode, 501, url);
    assert.equal(res.json().error, "not_configured");
  }
  const status = (await app.inject({ method: "GET", url: "/api/metadata/status", headers: user })).json();
  assert.deepEqual([status.providers.fanart, status.providers.discogs, status.providers.bandsintown], [false, false, false]);
  await configure({ fanartApiKey: "k-123", bandsintownAppId: "app-1" });
  const after = (await app.inject({ method: "GET", url: "/api/metadata/status", headers: user })).json();
  assert.deepEqual([after.providers.fanart, after.providers.bandsintown], [true, true]);
});

test("fanart sends the saved key as a header, and the key is never shown back", async () => {
  const { app, user, admin, calls, configure } = await setup();
  await configure({ fanartApiKey: "secret-fanart-key" });
  const res = await app.inject({ method: "GET", url: "/api/metadata/fanart/artist?mbid=" + A, headers: user });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().thumbs, ["https://assets.fanart.tv/t.jpg"], "http is upgraded to https");
  const call = calls.find((c) => c.url.includes("fanart.test"))!;
  assert.equal(call.headers["api-key"], "secret-fanart-key");
  assert.ok(!call.url.includes("secret-fanart-key"), "key is not in the URL");
  const cfg = await app.inject({ method: "GET", url: "/api/metadata/config", headers: admin });
  assert.equal(cfg.json().fanartApiKey, true);
  assert.ok(!cfg.body.includes("secret-fanart-key"));
});

test("concerts are filtered by city and carry ticket links", async () => {
  const { app, user, configure } = await setup();
  await configure({ bandsintownAppId: "app-1" });
  const all = (await app.inject({ method: "GET", url: "/api/metadata/events/artist?name=Radiohead", headers: user })).json();
  assert.equal(all.items.length, 2);
  const london = (await app.inject({ method: "GET", url: "/api/metadata/events/artist?name=Radiohead&city=lon", headers: user })).json();
  assert.deepEqual(london.items.map((e: { city: string }) => e.city), ["London"]);
  assert.equal(london.items[0].ticketUrl, "https://tix.example/1");
  assert.equal(london.items[0].latitude, 51.5);
});

test("an artist unknown to the concert service simply has no shows", async () => {
  const { app, user, configure } = await setup((url) => (url.includes("bandsintown") ? new Response("", { status: 404 }) : fakeWorld(url)));
  await configure({ bandsintownAppId: "app-1" });
  const res = await app.inject({ method: "GET", url: "/api/metadata/events/artist?name=Nobody", headers: user });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().items, []);
});

test("new releases keep this artist only, drop live albums, and search the right date range", async () => {
  const { app, user, calls } = await setup();
  const res = await app.inject({ method: "GET", url: "/api/metadata/releases/new?artist=Radiohead&days=30", headers: user });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().items.map((i: { title: string }) => i.title), ["New One"]);
  assert.equal(res.json().items[0].coverUrl, "https://coverartarchive.org/release-group/" + RG1 + "/front-250");
  const query = decodeURIComponent(calls.find((c) => c.url.includes("release-group"))!.url);
  assert.match(query, /firstreleasedate:\[2026-09-22 TO 2026-10-22\]/);
});

test("upstream errors become short safe answers without upstream text", async () => {
  const cases: [() => Response, number, string][] = [
    [() => new Response("secret internal detail", { status: 500 }), 502, "upstream_failed"],
    [() => new Response("", { status: 429, headers: { "retry-after": "9" } }), 503, "upstream_rate_limited"],
    [() => new Response("", { status: 403 }), 502, "upstream_auth"],
    [() => new Response("", { status: 404 }), 404, "not_found"],
  ];
  for (const [make, status, code] of cases) {
    const { app, user } = await setup((url) => (url.includes("musicbrainz.test") ? make() : fakeWorld(url)));
    const res = await app.inject({ method: "GET", url: "/api/metadata/musicbrainz/artist?name=Radiohead", headers: user });
    assert.equal(res.statusCode, status, code);
    assert.equal(res.json().error, code);
    assert.ok(!res.body.includes("secret internal detail"));
    assert.ok(!res.body.includes("musicbrainz.test"), "no upstream address leaks");
    if (status === 503) assert.equal(res.headers["retry-after"], "9");
  }
});

test("a lookup that fails is retried next time instead of being cached", async () => {
  let fail = true;
  const { app, user } = await setup((url) => (fail && url.includes("musicbrainz.test") ? new Response("", { status: 500 }) : fakeWorld(url)));
  const url = "/api/metadata/musicbrainz/artist?name=Radiohead";
  assert.equal((await app.inject({ method: "GET", url, headers: user })).statusCode, 502);
  fail = false;
  assert.equal((await app.inject({ method: "GET", url, headers: user })).statusCode, 200);
});

test("bad input is rejected before any upstream call", async () => {
  const { app, user, calls } = await setup();
  for (const url of [
    "/api/metadata/musicbrainz/artist",
    "/api/metadata/musicbrainz/artist?mbid=not-a-uuid",
    "/api/metadata/musicbrainz/artist?name=" + "x".repeat(300),
    "/api/metadata/coverart",
    "/api/metadata/releases/new",
  ]) {
    const res = await app.inject({ method: "GET", url, headers: user });
    assert.equal(res.statusCode, 400, url);
  }
  assert.equal(calls.length, 0);
});

test("config validation: keys are single words, addresses are http(s)", async () => {
  const { app, admin, configure, db } = await setup();
  assert.equal((await configure({ discogsToken: "two words" })).statusCode, 400);
  assert.equal((await configure({ baseUrls: { musicbrainz: "file:///etc/passwd" } })).statusCode, 400);
  assert.equal((await configure({ discogsToken: "tok" })).statusCode, 200);
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("plugin:" + METADATA_PLUGIN_ID + ":config") as { value: string };
  assert.equal(JSON.parse(row.value).discogsToken, "tok");
  assert.equal((await configure({ discogsToken: null })).statusCode, 200);
  const cfg = (await app.inject({ method: "GET", url: "/api/metadata/config", headers: admin })).json();
  assert.equal(cfg.discogsToken, false);
});

test("cover art by album name resolves a release group then the front image", async () => {
  const RG = "44444444-4444-4444-8444-444444444444";
  const { app, user } = await setup((url) => {
    if (url.includes("release-group?query=")) return json({ "release-groups": [{ id: RG, score: 100 }] });
    if (url.includes("coverart.test/release-group/" + RG)) {
      return json({ images: [{ front: false, image: "http://x.test/back.jpg" }, { front: true, image: "http://archive.org/full.jpg", thumbnails: { "500": "http://archive.org/500.jpg" } }] });
    }
    return fakeWorld(url);
  });
  const res = await app.inject({ method: "GET", url: "/api/metadata/coverart?album=OK%20Computer&artist=Radiohead", headers: user });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { url: "https://archive.org/500.jpg", full: "https://archive.org/full.jpg", mbid: RG, kind: "release-group" });
});
