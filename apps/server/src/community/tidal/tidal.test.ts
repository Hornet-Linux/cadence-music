import { test } from "node:test";
import assert from "node:assert/strict";
import { challengeFor } from "../_streaming/pkce.js";
import { FakeUpstream, json, setupApp, type TestApp } from "../_streaming/fakes.js";
import { isoSeconds } from "../_streaming/http.js";
import { createTidalPlugin, tracksOf } from "./plugin.js";

const CREDS = { clientId: "tidal-client", clientSecret: "tidal-secret", countryCode: "de" };

const SEARCH_DOC = {
  data: [
    { id: "100", type: "tracks" },
    { id: "101", type: "tracks" },
    { id: "9", type: "videos" },
  ],
  included: [
    {
      id: "100",
      type: "tracks",
      attributes: { title: "Song", version: "Remastered", duration: "PT3M20S", externalLinks: [{ href: "https://tidal.com/browse/track/100" }] },
      relationships: { artists: { data: [{ id: "a1", type: "artists" }, { id: "a2", type: "artists" }] }, albums: { data: [{ id: "al1", type: "albums" }] } },
    },
    { id: "101", type: "tracks", attributes: { title: "Bare", duration: "PT45S" } },
    { id: "a1", type: "artists", attributes: { name: "Alpha" } },
    { id: "a2", type: "artists", attributes: { name: "Beta" } },
    { id: "al1", type: "albums", attributes: { title: "The Album" }, relationships: { coverArt: { data: [{ id: "art1", type: "artworks" }] } } },
    {
      id: "art1",
      type: "artworks",
      attributes: { files: [{ href: "https://resources.tidal.com/80.jpg", meta: { width: 80 } }, { href: "https://resources.tidal.com/640.jpg", meta: { width: 640 } }, { href: "https://resources.tidal.com/1280.jpg", meta: { width: 1280 } }] },
    },
  ],
};

async function setup(configure?: (f: FakeUpstream) => void) {
  const fake = new FakeUpstream();
  fake.route("POST auth.tidal.com/v1/oauth2/token", (call) =>
    call.body?.get("grant_type") === "client_credentials" ? { access_token: "app-token", expires_in: 86400 } : json(400, { error: "invalid_grant" }),
  );
  fake.route("GET openapi.tidal.com/v2/searchResults/", () => SEARCH_DOC);
  configure?.(fake);
  const t = await setupApp(createTidalPlugin({ fetchFn: fake.fetchFn }));
  return { ...t, fake };
}

const configure = (t: TestApp) => t.app.inject({ method: "PUT", url: "/api/streaming/tidal/config", headers: t.admin, payload: CREDS });

test("durations in ISO 8601", () => {
  assert.equal(isoSeconds("PT3M20S"), 200);
  assert.equal(isoSeconds("PT1H2M3S"), 3723);
  assert.equal(isoSeconds("PT45S"), 45);
  assert.equal(isoSeconds("P0D"), undefined);
  assert.equal(isoSeconds(200), undefined);
});

test("JSON:API documents map to tracks with artists, album and cover, in listed order", () => {
  const { items } = tracksOf(SEARCH_DOC);
  assert.equal(items.length, 2, "videos are skipped");
  assert.deepEqual(items[0], {
    id: "100",
    title: "Song (Remastered)",
    artists: ["Alpha", "Beta"],
    album: "The Album",
    artwork: "https://resources.tidal.com/640.jpg",
    durationSec: 200,
    url: "https://tidal.com/browse/track/100",
    playback: "link",
    note: "Plays in TIDAL",
  });
  assert.equal(items[1]!.url, "https://tidal.com/track/101");
  assert.deepEqual(items[1]!.artists, []);
});

test("not configured: clear answer, no network", async () => {
  const { app, alice, fake } = await setup();
  const res = await app.inject({ url: "/api/streaming/tidal/search?q=x", headers: alice });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "tidal_not_configured");
  assert.equal(fake.calls.length, 0);
});

test("search: client-credentials token with Basic auth, JSON:API accept, country code, include parameters", async () => {
  const t = await setup();
  await configure(t);
  const res = (await t.app.inject({ url: "/api/streaming/tidal/search?q=a%2Fb%20c", headers: t.alice })).json();
  assert.equal(res.items.length, 2);
  await t.app.inject({ url: "/api/streaming/tidal/search?q=again", headers: t.alice });
  assert.equal(t.fake.count("POST auth.tidal.com/v1/oauth2/token"), 1);

  const token = t.fake.calls.find((c) => c.method === "POST")!;
  assert.equal(token.headers.get("authorization"), `Basic ${Buffer.from("tidal-client:tidal-secret").toString("base64")}`);
  const search = t.fake.calls.find((c) => c.url.pathname.startsWith("/v2/searchResults/"))!;
  assert.equal(search.url.pathname, "/v2/searchResults/a%2Fb%20c/relationships/tracks");
  assert.equal(search.url.searchParams.get("countryCode"), "DE");
  assert.match(search.url.searchParams.get("include")!, /tracks\.artists/);
  assert.equal(search.headers.get("authorization"), "Bearer app-token");
  assert.equal(search.headers.get("accept"), "application/vnd.api+json");
});

test("login uses PKCE S256 with the documented TIDAL endpoints and scopes; the verifier matches", async () => {
  const t = await setup((f) =>
    f.route("POST auth.tidal.com/v1/oauth2/token", (call) => {
      const g = call.body?.get("grant_type");
      if (g === "authorization_code") return { access_token: "u1", refresh_token: "r1", expires_in: 3600 };
      if (g === "client_credentials") return { access_token: "app", expires_in: 3600 };
      return json(400, {});
    }),
  );
  await configure(t);
  const start = await t.app.inject({ method: "POST", url: "/api/streaming/tidal/connect/start", headers: t.alice });
  const auth = new URL(start.json().url);
  assert.equal(auth.origin + auth.pathname, "https://login.tidal.com/authorize");
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.match(auth.searchParams.get("scope")!, /collection\.read/);
  assert.equal(auth.searchParams.get("redirect_uri"), "https://cadence.example/api/streaming/tidal/callback");

  const done = await t.app.inject({ url: `/api/streaming/tidal/callback?code=cc&state=${auth.searchParams.get("state")}` });
  assert.equal(done.statusCode, 200);
  const ex = t.fake.calls.find((c) => c.body?.get("grant_type") === "authorization_code")!;
  assert.equal(challengeFor(ex.body!.get("code_verifier")!), auth.searchParams.get("code_challenge"));
  assert.equal(ex.body!.get("code"), "cc");
  assert.equal((await t.app.inject({ url: "/api/streaming/tidal/status", headers: t.alice })).json().connected, true);
});

test("saved tracks and playlists use the person's token, refresh when due, and map their documents", async () => {
  let refreshed = 0;
  const t = await setup((f) => {
    f.route("POST auth.tidal.com/v1/oauth2/token", (call) => {
      const g = call.body?.get("grant_type");
      if (g === "authorization_code") return { access_token: "u1", refresh_token: "r1", expires_in: 5 };
      if (g === "refresh_token") {
        refreshed++;
        assert.equal(call.body!.get("refresh_token"), "r1");
        return { access_token: "u2", refresh_token: "r2", expires_in: 3600 };
      }
      return { access_token: "app", expires_in: 3600 };
    });
    f.route("GET openapi.tidal.com/v2/userCollections/me/relationships/tracks", () => SEARCH_DOC);
    f.route("GET openapi.tidal.com/v2/users/me", () => ({ data: { id: "777", type: "users" } }));
    f.route("GET openapi.tidal.com/v2/playlists", () => ({
      data: [{ id: "uuid-1", type: "playlists", attributes: { name: "Evening", numberOfItems: 9 }, relationships: { coverArt: { data: [{ id: "art1", type: "artworks" }] } } }],
      included: SEARCH_DOC.included,
    }));
    f.route("GET openapi.tidal.com/v2/playlists/uuid-1/relationships/items", () => SEARCH_DOC);
  });
  await configure(t);
  const start = await t.app.inject({ method: "POST", url: "/api/streaming/tidal/connect/start", headers: t.alice });
  await t.app.inject({ url: `/api/streaming/tidal/callback?code=c&state=${new URL(start.json().url).searchParams.get("state")}` });

  const lib = (await t.app.inject({ url: "/api/streaming/tidal/library/tracks", headers: t.alice })).json();
  assert.equal(lib.items.length, 2);
  assert.equal(refreshed, 1);
  assert.equal(t.fake.calls.find((c) => c.url.pathname.endsWith("/userCollections/me/relationships/tracks"))!.headers.get("authorization"), "Bearer u2");

  const pls = (await t.app.inject({ url: "/api/streaming/tidal/playlists", headers: t.alice })).json();
  assert.deepEqual(pls.items, [{ id: "uuid-1", name: "Evening", artwork: "https://resources.tidal.com/640.jpg", trackCount: 9, url: "https://tidal.com/playlist/uuid-1" }]);
  const owner = t.fake.calls.find((c) => c.url.pathname === "/v2/playlists")!;
  assert.equal(owner.url.searchParams.get("filter[r.owners.id]"), "777");
  const items = (await t.app.inject({ url: "/api/streaming/tidal/playlists/uuid-1/tracks", headers: t.alice })).json();
  assert.equal(items.items.length, 2);
  assert.equal((await t.app.inject({ url: "/api/streaming/tidal/playlists/a%2Fb/tracks", headers: t.alice })).statusCode, 400);
});

test("a missing connection is a 409 for library calls", async () => {
  const t = await setup();
  await configure(t);
  const res = await t.app.inject({ url: "/api/streaming/tidal/library/tracks", headers: t.alice });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "tidal_not_connected");
});
