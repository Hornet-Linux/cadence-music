import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { challengeFor } from "../_streaming/pkce.js";
import { FakeUpstream, json, setupApp, type TestApp } from "../_streaming/fakes.js";
import { createSoundCloudPlugin, toTrack } from "./plugin.js";

const CREDS = { clientId: "sc-client-id", clientSecret: "sc-client-secret" };

const TRACKS = [
  { id: 11, title: "Open Track", duration: 215_000, permalink_url: "https://soundcloud.com/a/open", artwork_url: "https://i1.sndcdn.com/art-large.jpg", access: "playable", user: { username: "Artist A" } },
  { id: 12, title: "Short One", duration: 30_000, permalink_url: "https://soundcloud.com/a/short", artwork_url: null, access: "preview", user: { username: "Artist B" } },
  { id: 13, title: "Locked", duration: 1000, permalink_url: "https://soundcloud.com/a/locked", access: "blocked", user: { username: "Artist C" } },
  { id: 14, title: "No link", duration: 1000, user: { username: "X" } },
];

async function setup(configure?: (f: FakeUpstream) => void) {
  const fake = new FakeUpstream();
  fake.route("POST secure.soundcloud.com/oauth/token", (call) => {
    const grant = call.body?.get("grant_type");
    if (grant === "client_credentials") return { access_token: `app-${fake.count("POST secure.soundcloud.com/oauth/token")}`, expires_in: 3600 };
    return json(400, { error: "invalid_grant" });
  });
  fake.route("GET api.soundcloud.com/tracks", () => TRACKS);
  configure?.(fake);
  const t = await setupApp(createSoundCloudPlugin({ fetchFn: fake.fetchFn }));
  return { ...t, fake };
}

const configure = (t: TestApp) => t.app.inject({ method: "PUT", url: "/api/streaming/soundcloud/config", headers: t.admin, payload: CREDS });

test("without credentials it says so and makes no network calls", async () => {
  const { app, alice, fake } = await setup();
  const status = (await app.inject({ url: "/api/streaming/soundcloud/status", headers: alice })).json();
  assert.equal(status.configured, false);
  assert.equal(status.connected, false);
  const res = await app.inject({ url: "/api/streaming/soundcloud/search?q=x", headers: alice });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "soundcloud_not_configured");
  assert.equal(fake.calls.length, 0);
});

test("only an admin can save credentials, and the secret is stored encrypted and never returned", async () => {
  const t = await setup();
  const denied = await t.app.inject({ method: "PUT", url: "/api/streaming/soundcloud/config", headers: t.alice, payload: CREDS });
  assert.equal(denied.statusCode, 403);
  assert.equal((await configure(t)).statusCode, 204);

  const read = (await t.app.inject({ url: "/api/streaming/soundcloud/config", headers: t.admin })).json();
  assert.equal(read.configured, true);
  assert.equal(read.redirectUri, "https://cadence.example/api/streaming/soundcloud/callback");
  const secretField = read.fields.find((f: { key: string }) => f.key === "clientSecret");
  assert.equal(secretField.set, true);
  assert.equal(secretField.value, undefined);
  assert.ok(!JSON.stringify(read).includes(CREDS.clientSecret));

  const row = t.db.prepare("SELECT value FROM settings WHERE key = 'plugin:cadence.soundcloud:config'").get() as { value: string };
  assert.ok(!row.value.includes(CREDS.clientSecret), "secret must not be stored in plain text");
  assert.ok(row.value.includes(CREDS.clientId));

  // An empty secret keeps the old one; a bad value is refused.
  assert.equal((await t.app.inject({ method: "PUT", url: "/api/streaming/soundcloud/config", headers: t.admin, payload: { clientSecret: "" } })).statusCode, 204);
  assert.equal((await t.app.inject({ url: "/api/streaming/soundcloud/status", headers: t.alice })).json().configured, true);
  assert.equal((await t.app.inject({ method: "PUT", url: "/api/streaming/soundcloud/config", headers: t.admin, payload: { clientId: "has space" } })).statusCode, 400);
});

test("search uses a cached client-credentials token and maps tracks", async () => {
  const t = await setup();
  await configure(t);
  const first = (await t.app.inject({ url: "/api/streaming/soundcloud/search?q=night", headers: t.alice })).json();
  await t.app.inject({ url: "/api/streaming/soundcloud/search?q=day", headers: t.bob });

  assert.equal(t.fake.count("POST secure.soundcloud.com/oauth/token"), 1, "token minted once, then cached");
  const tokenCall = t.fake.calls.find((c) => c.method === "POST")!;
  assert.equal(tokenCall.headers.get("authorization"), `Basic ${Buffer.from("sc-client-id:sc-client-secret").toString("base64")}`);
  const search = t.fake.calls.find((c) => c.url.pathname === "/tracks")!;
  assert.equal(search.headers.get("authorization"), "OAuth app-1");
  assert.equal(search.url.searchParams.get("q"), "night");

  // The entry without a permalink is dropped; durations are converted from milliseconds.
  assert.equal(first.items.length, 3);
  assert.deepEqual(first.items[0], {
    id: "11",
    title: "Open Track",
    artists: ["Artist A"],
    artwork: "https://i1.sndcdn.com/art-t300x300.jpg",
    durationSec: 215,
    url: "https://soundcloud.com/a/open",
    playback: "widget",
  });
  assert.equal(first.items[1].note, "Preview only");
  assert.equal(first.items[2].playback, "link");
});

test("a refused cached app token is replaced once", async () => {
  let rejectOnce = true;
  const t = await setup((f) =>
    f.route("GET api.soundcloud.com/tracks", () => {
      if (rejectOnce) {
        rejectOnce = false;
        return json(401, { message: "expired" });
      }
      return TRACKS;
    }),
  );
  await configure(t);
  const res = await t.app.inject({ url: "/api/streaming/soundcloud/search?q=x", headers: t.alice });
  assert.equal(res.statusCode, 200);
  assert.equal(t.fake.count("POST secure.soundcloud.com/oauth/token"), 2);
});

test("upstream failures give fixed messages and never leak upstream text", async () => {
  const t = await setup((f) => f.route("GET api.soundcloud.com/tracks", () => json(500, { error: "secret-internal-detail" })));
  await configure(t);
  const res = await t.app.inject({ url: "/api/streaming/soundcloud/search?q=x", headers: t.alice });
  assert.equal(res.statusCode, 502);
  assert.ok(!res.body.includes("secret-internal-detail"));
  assert.equal(res.json().error, "soundcloud_failed");
});

test("PKCE login: challenge is S256, the verifier is sent on exchange, and tokens are stored per person", async () => {
  const t = await setup((f) =>
    f.route("POST secure.soundcloud.com/oauth/token", (call) => {
      if (call.body?.get("grant_type") === "authorization_code") {
        return { access_token: "user-access", refresh_token: "user-refresh-1", expires_in: 3600 };
      }
      return { access_token: "app", expires_in: 3600 };
    }),
  );
  await configure(t);

  const start = await t.app.inject({ method: "POST", url: "/api/streaming/soundcloud/connect/start", headers: t.alice });
  assert.equal(start.statusCode, 200);
  const auth = new URL(start.json().url);
  assert.equal(auth.origin + auth.pathname, "https://secure.soundcloud.com/authorize");
  assert.equal(auth.searchParams.get("client_id"), CREDS.clientId);
  assert.equal(auth.searchParams.get("response_type"), "code");
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(auth.searchParams.get("redirect_uri"), "https://cadence.example/api/streaming/soundcloud/callback");
  const state = auth.searchParams.get("state")!;
  const challenge = auth.searchParams.get("code_challenge")!;
  assert.ok(state.length >= 24);

  // A wrong state is refused and no exchange is attempted.
  const bad = await t.app.inject({ url: "/api/streaming/soundcloud/callback?code=abc&state=nope" });
  assert.equal(bad.statusCode, 400);
  assert.equal(t.fake.calls.filter((c) => c.body?.get("grant_type") === "authorization_code").length, 0);

  const done = await t.app.inject({ url: `/api/streaming/soundcloud/callback?code=the-code&state=${state}` });
  assert.equal(done.statusCode, 200);
  assert.match(done.body, /connected/);
  assert.equal(done.headers["referrer-policy"], "no-referrer");

  const exchange = t.fake.calls.find((c) => c.body?.get("grant_type") === "authorization_code")!;
  assert.equal(exchange.body!.get("code"), "the-code");
  assert.equal(exchange.body!.get("client_secret"), CREDS.clientSecret);
  assert.equal(exchange.body!.get("redirect_uri"), "https://cadence.example/api/streaming/soundcloud/callback");
  assert.equal(challengeFor(exchange.body!.get("code_verifier")!), challenge, "verifier matches the challenge");
  assert.equal(createHash("sha256").update(exchange.body!.get("code_verifier")!).digest("base64url"), challenge);

  // The state is single use.
  const replay = await t.app.inject({ url: `/api/streaming/soundcloud/callback?code=the-code&state=${state}` });
  assert.equal(replay.statusCode, 400);

  assert.equal((await t.app.inject({ url: "/api/streaming/soundcloud/status", headers: t.alice })).json().connected, true);
  assert.equal((await t.app.inject({ url: "/api/streaming/soundcloud/status", headers: t.bob })).json().connected, false);

  const rows = t.db.prepare("SELECT value FROM settings WHERE key LIKE 'plugin:cadence.soundcloud:user:%'").all() as { value: string }[];
  assert.equal(rows.length, 1);
  assert.ok(!rows[0]!.value.includes("user-access") && !rows[0]!.value.includes("user-refresh-1"));

  const off = await t.app.inject({ method: "DELETE", url: "/api/streaming/soundcloud/connection", headers: t.alice });
  assert.equal(off.statusCode, 204);
  assert.equal((await t.app.inject({ url: "/api/streaming/soundcloud/status", headers: t.alice })).json().connected, false);
});

async function connectAlice(t: Awaited<ReturnType<typeof setup>>) {
  await configure(t);
  const start = await t.app.inject({ method: "POST", url: "/api/streaming/soundcloud/connect/start", headers: t.alice });
  const state = new URL(start.json().url).searchParams.get("state")!;
  await t.app.inject({ url: `/api/streaming/soundcloud/callback?code=c&state=${state}` });
}

test("expired tokens are refreshed once, even for concurrent requests, and the new refresh token replaces the old", async () => {
  let refreshCalls = 0;
  const seenRefresh: string[] = [];
  const t = await setup((f) => {
    f.route("POST secure.soundcloud.com/oauth/token", async (call) => {
      const grant = call.body?.get("grant_type");
      if (grant === "authorization_code") return { access_token: "a0", refresh_token: "r0", expires_in: 1 }; // expires at once
      if (grant === "refresh_token") {
        refreshCalls++;
        seenRefresh.push(call.body!.get("refresh_token")!);
        await new Promise((r) => setTimeout(r, 20));
        return { access_token: `a${refreshCalls}`, refresh_token: `r${refreshCalls}`, expires_in: 3600 };
      }
      return { access_token: "app", expires_in: 3600 };
    });
    f.route("GET api.soundcloud.com/me/likes/tracks", () => TRACKS);
  });
  await connectAlice(t);

  const [x, y] = await Promise.all([
    t.app.inject({ url: "/api/streaming/soundcloud/library/tracks", headers: t.alice }),
    t.app.inject({ url: "/api/streaming/soundcloud/library/tracks", headers: t.alice }),
  ]);
  assert.equal(x.statusCode, 200);
  assert.equal(y.statusCode, 200);
  assert.equal(refreshCalls, 1, "single-use refresh tokens must not be spent twice");
  assert.deepEqual(seenRefresh, ["r0"]);
  const used = t.fake.calls.filter((c) => c.url.pathname === "/me/likes/tracks").map((c) => c.headers.get("authorization"));
  assert.deepEqual(used, ["OAuth a1", "OAuth a1"]);

  // Later calls use the stored rotated token without refreshing again.
  await t.app.inject({ url: "/api/streaming/soundcloud/library/tracks", headers: t.alice });
  assert.equal(refreshCalls, 1);
});

test("a refused refresh signs the person out of SoundCloud only, with a 409 rather than a 401", async () => {
  const t = await setup((f) => {
    f.route("POST secure.soundcloud.com/oauth/token", (call) => {
      const grant = call.body?.get("grant_type");
      if (grant === "authorization_code") return { access_token: "a0", refresh_token: "r0", expires_in: 1 };
      if (grant === "refresh_token") return json(400, { error: "invalid_grant" });
      return { access_token: "app", expires_in: 3600 };
    });
  });
  await connectAlice(t);
  const res = await t.app.inject({ url: "/api/streaming/soundcloud/library/tracks", headers: t.alice });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "soundcloud_session_expired");
  assert.equal((await t.app.inject({ url: "/api/streaming/soundcloud/status", headers: t.alice })).json().connected, false);
});

test("library calls need a connection", async () => {
  const t = await setup();
  await configure(t);
  const res = await t.app.inject({ url: "/api/streaming/soundcloud/playlists", headers: t.alice });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "soundcloud_not_connected");
});

test("toTrack rejects entries it cannot show", () => {
  assert.equal(toTrack({ id: "x", title: "t", permalink_url: "https://soundcloud.com/a" }), null);
  assert.equal(toTrack({ id: 5, title: "t", permalink_url: "javascript:alert(1)" }), null);
});
