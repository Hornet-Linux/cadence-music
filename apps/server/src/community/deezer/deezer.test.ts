import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeUpstream, json, setupApp, type TestApp } from "../_streaming/fakes.js";
import { createDeezerPlugin, toTrack } from "./plugin.js";

const CREDS = { appId: "123456", appSecret: "dz-secret-value" };

const TRACK = {
  id: 3135556,
  title: "Harder, Better, Faster, Stronger",
  title_short: "Harder, Better, Faster, Stronger",
  duration: 224,
  preview: "https://cdnt-preview.dzcdn.net/api/1/1/a/b/c.mp3?hdnea=exp=1",
  link: "https://www.deezer.com/track/3135556",
  artist: { id: 27, name: "Daft Punk" },
  album: { title: "Discovery", cover_big: "https://cdn-images.dzcdn.net/images/cover/x/500x500.jpg" },
};

async function setup(configure?: (f: FakeUpstream) => void) {
  const fake = new FakeUpstream();
  fake.route("GET api.deezer.com/search/track", () => ({ data: [TRACK, { id: 9, title: "No preview", duration: 100, preview: "", artist: { name: "Z" } }, { id: "bad id", title: "x" }], total: 2 }));
  fake.route("GET api.deezer.com/track/", () => TRACK);
  configure?.(fake);
  const t = await setupApp(createDeezerPlugin({ fetchFn: fake.fetchFn }));
  return { ...t, fake };
}

const configure = (t: TestApp) => t.app.inject({ method: "PUT", url: "/api/streaming/deezer/config", headers: t.admin, payload: CREDS });

async function connectAlice(t: Awaited<ReturnType<typeof setup>>) {
  const start = await t.app.inject({ method: "POST", url: "/api/streaming/deezer/connect/start", headers: t.alice });
  const url = new URL(start.json().url);
  await t.app.inject({ url: `/api/streaming/deezer/callback?code=dz-code&state=${url.searchParams.get("state")}` });
  return url;
}

test("not configured: clear answer, no network", async () => {
  const { app, alice, fake } = await setup();
  assert.equal((await app.inject({ url: "/api/streaming/deezer/status", headers: alice })).json().configured, false);
  const res = await app.inject({ url: "/api/streaming/deezer/search?q=daft", headers: alice });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "deezer_not_configured");
  const start = await app.inject({ method: "POST", url: "/api/streaming/deezer/connect/start", headers: alice });
  assert.equal(start.statusCode, 409);
  assert.equal(fake.calls.length, 0);
});

test("search maps tracks: previews are playable, others link out", async () => {
  const t = await setup();
  await configure(t);
  const res = (await t.app.inject({ url: "/api/streaming/deezer/search?q=daft%20punk&limit=5", headers: t.alice })).json();
  assert.equal(res.items.length, 2);
  assert.deepEqual(res.items[0], {
    id: "3135556",
    title: "Harder, Better, Faster, Stronger",
    artists: ["Daft Punk"],
    album: "Discovery",
    artwork: "https://cdn-images.dzcdn.net/images/cover/x/500x500.jpg",
    durationSec: 224,
    url: "https://www.deezer.com/track/3135556",
    playback: "preview",
  });
  assert.equal(res.items[1].playback, "link");
  const call = t.fake.calls[0]!;
  assert.equal(call.url.searchParams.get("q"), "daft punk");
  assert.equal(call.url.searchParams.get("limit"), "5");
  assert.equal(call.url.searchParams.has("access_token"), false, "search is public");
});

test("a fresh preview URL is looked up at play time and validated", async () => {
  const t = await setup((f) => f.route("GET api.deezer.com/track/404", () => json(200, { error: { type: "DataException", code: 800 } })));
  await configure(t);
  const ok = await t.app.inject({ url: "/api/streaming/deezer/tracks/3135556/preview", headers: t.alice });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().url, TRACK.preview);
  assert.equal((await t.app.inject({ url: "/api/streaming/deezer/tracks/..%2Fuser/preview", headers: t.alice })).statusCode, 400);
  assert.equal((await t.app.inject({ url: "/api/streaming/deezer/tracks/404/preview", headers: t.alice })).statusCode, 404);
});

test("a track without a preview answers 404 instead of a broken URL", async () => {
  const t = await setup((f) => f.route("GET api.deezer.com/track/7", () => ({ id: 7, title: "x", preview: "javascript:alert(1)" })));
  await configure(t);
  assert.equal((await t.app.inject({ url: "/api/streaming/deezer/tracks/7/preview", headers: t.alice })).statusCode, 404);
});

test("login uses the code flow without PKCE (Deezer documents none), checks state, and keeps the secret server-side", async () => {
  const t = await setup((f) => f.route("GET connect.deezer.com/oauth/access_token.php", () => ({ access_token: "dz-user-token", expires: 0 })));
  await configure(t);
  const auth = await connectAlice(t);
  assert.equal(auth.origin + auth.pathname, "https://connect.deezer.com/oauth/auth.php");
  assert.equal(auth.searchParams.get("app_id"), CREDS.appId);
  assert.equal(auth.searchParams.get("perms"), "basic_access,offline_access");
  assert.equal(auth.searchParams.has("code_challenge"), false);
  assert.equal(auth.searchParams.has("secret"), false, "the secret is never in the browser URL");

  const exchange = t.fake.calls.find((c) => c.url.pathname === "/oauth/access_token.php")!;
  assert.equal(exchange.url.searchParams.get("secret"), CREDS.appSecret);
  assert.equal(exchange.url.searchParams.get("code"), "dz-code");
  assert.equal((await t.app.inject({ url: "/api/streaming/deezer/status", headers: t.alice })).json().connected, true);

  const bad = await t.app.inject({ url: "/api/streaming/deezer/callback?code=x&state=forged" });
  assert.equal(bad.statusCode, 400);
});

test("a non-expiring offline token is used as is; library and playlists use it", async () => {
  const t = await setup((f) => {
    f.route("GET connect.deezer.com/oauth/access_token.php", () => ({ access_token: "dz-user-token", expires: 0 }));
    f.route("GET api.deezer.com/user/me/tracks", () => ({ data: [TRACK], total: 41 }));
    f.route("GET api.deezer.com/user/me/playlists", () => ({ data: [{ id: 55, title: "Road trip", nb_tracks: 12, picture_medium: "https://cdn/p.jpg", link: "https://www.deezer.com/playlist/55" }], total: 1 }));
    f.route("GET api.deezer.com/playlist/55/tracks", () => ({ data: [TRACK], total: 1 }));
  });
  await configure(t);
  await connectAlice(t);

  const lib = (await t.app.inject({ url: "/api/streaming/deezer/library/tracks", headers: t.alice })).json();
  assert.equal(lib.total, 41);
  assert.equal(t.fake.calls.find((c) => c.url.pathname === "/user/me/tracks")!.url.searchParams.get("access_token"), "dz-user-token");
  const pls = (await t.app.inject({ url: "/api/streaming/deezer/playlists", headers: t.alice })).json();
  assert.deepEqual(pls.items[0], { id: "55", name: "Road trip", artwork: "https://cdn/p.jpg", trackCount: 12, url: "https://www.deezer.com/playlist/55" });
  const tracks = (await t.app.inject({ url: "/api/streaming/deezer/playlists/55/tracks", headers: t.alice })).json();
  assert.equal(tracks.items.length, 1);
  assert.equal((await t.app.inject({ url: "/api/streaming/deezer/playlists/5x/tracks", headers: t.alice })).statusCode, 400);

  // Bob never connected.
  const bob = await t.app.inject({ url: "/api/streaming/deezer/library/tracks", headers: t.bob });
  assert.equal(bob.statusCode, 409);
  assert.equal(bob.json().error, "deezer_not_connected");
});

test("Deezer's 200-with-error-object token failure ends the session cleanly (409, not 401)", async () => {
  const t = await setup((f) => {
    f.route("GET connect.deezer.com/oauth/access_token.php", () => ({ access_token: "old", expires: 0 }));
    f.route("GET api.deezer.com/user/me/tracks", () => ({ error: { type: "OAuthException", message: "Invalid OAuth access token.", code: 300 } }));
  });
  await configure(t);
  await connectAlice(t);
  const res = await t.app.inject({ url: "/api/streaming/deezer/library/tracks", headers: t.alice });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "deezer_session_expired");
  assert.ok(!res.body.includes("Invalid OAuth"));
  assert.equal((await t.app.inject({ url: "/api/streaming/deezer/status", headers: t.alice })).json().connected, false);
});

test("a failed token exchange is reported without leaking details", async () => {
  const t = await setup((f) => f.route("GET connect.deezer.com/oauth/access_token.php", () => json(200, { error: "bad secret abc" })));
  await configure(t);
  const start = await t.app.inject({ method: "POST", url: "/api/streaming/deezer/connect/start", headers: t.alice });
  const state = new URL(start.json().url).searchParams.get("state");
  const cb = await t.app.inject({ url: `/api/streaming/deezer/callback?code=c&state=${state}` });
  assert.equal(cb.statusCode, 502);
  assert.ok(!cb.body.includes("abc"));
  const status = (await t.app.inject({ url: "/api/streaming/deezer/status", headers: t.alice })).json();
  assert.equal(status.connected, false);
  assert.match(status.loginError, /Deezer sign-in failed/);
});

test("toTrack drops entries without a numeric id or a title", () => {
  assert.equal(toTrack({ id: "abc", title: "x" }), null);
  assert.equal(toTrack({ id: 1 }), null);
});
