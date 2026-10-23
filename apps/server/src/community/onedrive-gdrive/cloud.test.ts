import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { createLocalUser } from "../../auth/users.js";
import type { Config } from "../../config.js";
import { openDb, type Db } from "../../db.js";
import { open } from "../../llm/secretBox.js";
import { makeMp3 } from "../../sources/testAudio.js";
import { FakeCloud } from "./fakeCloud.js";
import { makeState, readState, verifierFor } from "./oauth.js";
import { CLOUD_PLUGIN_ID, createCloudDrivePlugin } from "./plugin.js";
import type { ProviderId } from "./providers.js";

const SECRET = "s".repeat(64);
const PUBLIC_URL = "https://cadence.example";
const ALLOW = { SOURCES_ALLOW_PRIVATE_NETWORK: "true" } as NodeJS.ProcessEnv;
const count = (db: Db, sql: string) => (db.prepare(sql).get() as { n: number }).n;

type AuthHeader = { authorization: string };

async function setup(cloud: FakeCloud, opts: { publicUrl?: string | null; now?: () => number } = {}) {
  const db: Db = openDb(":memory:");
  await createLocalUser(db, { username: "admin", password: "admin-password", isAdmin: true });
  await createLocalUser(db, { username: "alice", password: "alice-password" });
  await createLocalUser(db, { username: "bob", password: "bob-password" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-cloud-"));
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    musicDir: dir,
    scanIntervalMinutes: 0,
    trustProxy: false,
    logLevel: "silent",
    ...(opts.publicUrl === null ? {} : { publicUrl: opts.publicUrl ?? PUBLIC_URL }),
  };
  const plugin = createCloudDrivePlugin({
    env: ALLOW,
    now: opts.now,
    endpoints: { google: cloud.endpoints("google"), microsoft: cloud.endpoints("microsoft") },
  });
  const app = await buildApp({ config, db, secret: SECRET, logger: false, plugins: [plugin] });
  const signIn = async (username: string) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: `${username}-password` } });
    return { authorization: `Bearer ${(res.json() as { token: string }).token}` };
  };
  return { app, db, admin: await signIn("admin"), alice: await signIn("alice"), bob: await signIn("bob") };
}

async function registerApps(app: FastifyInstance, admin: AuthHeader, cloud: FakeCloud) {
  for (const provider of ["google", "microsoft"]) {
    const res = await app.inject({ method: "PUT", url: "/api/onedrive-gdrive/apps", headers: admin, payload: { provider, clientId: cloud.clientId, clientSecret: cloud.clientSecret } });
    assert.equal(res.statusCode, 200, res.body);
  }
}

/** Sign in the way a browser would: ask for the link, consent at the provider, come back to the callback. */
async function signInTo(app: FastifyInstance, headers: AuthHeader, cloud: FakeCloud, provider: ProviderId) {
  const start = await app.inject({ method: "POST", url: `/api/onedrive-gdrive/${provider}/authorize`, headers });
  assert.equal(start.statusCode, 200, start.body);
  const { url } = start.json() as { url: string };
  const { code, state } = cloud.consent(provider, url);
  return app.inject({ method: "GET", url: `/api/onedrive-gdrive/callback?code=${code}&state=${encodeURIComponent(state)}` });
}

async function indexNow(app: FastifyInstance, headers: AuthHeader, provider: ProviderId) {
  const res = await app.inject({ method: "POST", url: `/api/onedrive-gdrive/${provider}/index?wait=1`, headers });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { indexing: { status: string; found: number; error: string | null }; trackCount: number };
}

async function tracks(app: FastifyInstance, headers: AuthHeader, provider: ProviderId, query = "") {
  const res = await app.inject({ method: "GET", url: `/api/onedrive-gdrive/${provider}/tracks${query}`, headers });
  assert.equal(res.statusCode, 200);
  return res.json() as { items: { id: string; title: string; artist: string | null; location: string | null }[]; total: number };
}

function fill(cloud: FakeCloud, p: ProviderId) {
  const music = cloud.folder(p, "Music");
  const owls = cloud.folder(p, "Night Owls", music);
  cloud.file(p, "01 Blue Hour.mp3", owls, makeMp3({ title: "Blue Hour", artist: "Night Owls", album: "After Dark", track: 1, frames: 200 }));
  cloud.file(p, "02 Moth.mp3", owls, makeMp3({ title: "Moth", artist: "Night Owls", album: "After Dark", track: 2, frames: 200 }));
  cloud.file(p, "cover.jpg", owls, Buffer.from("jpeg"));
  const other = cloud.folder(p, "Podcasts");
  cloud.file(p, "Episode.mp3", other, makeMp3({ title: "Episode 1", frames: 40 }));
  cloud.file(p, "root song.mp3", "root", makeMp3({ title: "Root Song", frames: 40 }));
  return { music, owls, other };
}

test("only the server owner can register the OAuth apps, and the client secret is sealed and never shown", async () => {
  const cloud = await new FakeCloud().start();
  const { app, db, admin, alice } = await setup(cloud);
  try {
    const attempt = { provider: "google", clientId: cloud.clientId, clientSecret: cloud.clientSecret };
    assert.equal((await app.inject({ method: "PUT", url: "/api/onedrive-gdrive/apps", headers: alice, payload: attempt })).statusCode, 403);
    assert.equal((await app.inject({ method: "GET", url: "/api/onedrive-gdrive/apps", headers: alice })).statusCode, 403);
    assert.equal((await app.inject({ method: "PUT", url: "/api/onedrive-gdrive/apps", headers: admin, payload: { provider: "google", clientId: "x" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "PUT", url: "/api/onedrive-gdrive/apps", headers: admin, payload: { provider: "dropbox", clientId: cloud.clientId, clientSecret: "s" } })).statusCode, 400);
    const ok = await app.inject({ method: "PUT", url: "/api/onedrive-gdrive/apps", headers: admin, payload: attempt });
    assert.equal(ok.statusCode, 200);
    assert.ok(!ok.body.includes(cloud.clientSecret));
    const view = ok.json() as { redirectUri: string; google: { configured: boolean; clientId: string }; microsoft: { configured: boolean } };
    assert.equal(view.redirectUri, `${PUBLIC_URL}/api/onedrive-gdrive/callback`);
    assert.deepEqual([view.google.configured, view.microsoft.configured], [true, false]);

    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(`plugin:${CLOUD_PLUGIN_ID}:config`) as { value: string };
    assert.ok(!row.value.includes(cloud.clientSecret), "no plain text in the database");
    const stored = JSON.parse(row.value) as { google: { clientSecretEnc: string } };
    assert.equal(open(stored.google.clientSecretEnc, SECRET, "cadence-cloud-oauth-client-secrets"), cloud.clientSecret);

    // Updating the ID without a new secret keeps the secret.
    const keep = await app.inject({ method: "PUT", url: "/api/onedrive-gdrive/apps", headers: admin, payload: { provider: "google", clientId: "another-client-id-1" } });
    assert.equal(keep.statusCode, 200);
    assert.equal((await app.inject({ method: "DELETE", url: "/api/onedrive-gdrive/apps/google", headers: admin })).statusCode, 204);
    assert.equal((await app.inject({ method: "GET", url: "/api/onedrive-gdrive/apps", headers: admin })).json<{ google: { configured: boolean } }>().google.configured, false);
  } finally {
    await app.close();
    await cloud.stop();
  }
});

test("signing in needs a registered app and a PUBLIC_URL, and says so", async () => {
  const cloud = await new FakeCloud().start();
  const noApp = await setup(cloud);
  const noUrl = await setup(cloud, { publicUrl: null });
  try {
    const none = await noApp.app.inject({ method: "POST", url: "/api/onedrive-gdrive/google/authorize", headers: noApp.alice });
    assert.equal(none.statusCode, 409);
    assert.equal((none.json() as { error: string }).error, "onedrive-gdrive_not_configured");
    await registerApps(noUrl.app, noUrl.admin, cloud);
    const res = await noUrl.app.inject({ method: "POST", url: "/api/onedrive-gdrive/microsoft/authorize", headers: noUrl.alice });
    assert.equal((res.json() as { error: string }).error, "onedrive-gdrive_no_public_url");
    assert.equal((await noApp.app.inject({ method: "POST", url: "/api/onedrive-gdrive/dropbox/authorize", headers: noApp.alice })).statusCode, 404);
    assert.equal((await noApp.app.inject({ method: "POST", url: "/api/onedrive-gdrive/google/authorize" })).statusCode, 401);
    const status = (await noApp.app.inject({ method: "GET", url: "/api/onedrive-gdrive/status", headers: noApp.alice })).json() as {
      google: { configured: boolean; connected: boolean };
    };
    assert.deepEqual([status.google.configured, status.google.connected], [false, false]);
  } finally {
    await noApp.app.close();
    await noUrl.app.close();
    await cloud.stop();
  }
});

test("Google Drive: sign in with PKCE, index the chosen folders, stream with ranges", async () => {
  const cloud = await new FakeCloud().start();
  cloud.pageSize = 2; // paging
  const ids = fill(cloud, "google");
  const { app, db, admin, alice, bob } = await setup(cloud);
  try {
    await registerApps(app, admin, cloud);
    const page = await signInTo(app, alice, cloud, "google");
    assert.equal(page.statusCode, 200);
    assert.match(String(page.headers["content-type"]), /text\/html/);
    assert.match(String(page.headers["content-security-policy"]), /default-src 'none'/);
    assert.ok(!page.body.includes("code="), "nothing from the URL is echoed back");

    const status = (await app.inject({ method: "GET", url: "/api/onedrive-gdrive/status", headers: alice })).json() as {
      google: { connected: boolean; account: string; configured: boolean };
    };
    assert.deepEqual([status.google.connected, status.google.account], [true, "me@gmail.example"]);

    // The refresh token is sealed at rest and never returned.
    const row = db.prepare("SELECT value FROM settings WHERE key LIKE ?").get(`plugin:${CLOUD_PLUGIN_ID}:user:%`) as { value: string };
    const stored = JSON.parse(row.value) as { google: { refreshTokenEnc: string } };
    assert.ok(stored.google.refreshTokenEnc.startsWith("v1."));
    assert.ok(!row.value.includes(cloud.clientSecret));
    const refresh = open(stored.google.refreshTokenEnc, SECRET, "cadence-cloud-refresh-tokens")!;
    assert.ok(refresh.length > 10 && !JSON.stringify(status).includes(refresh));

    // Whole drive first (no folders chosen): finds audio at every depth, skips images.
    const all = await indexNow(app, alice, "google");
    assert.equal(all.indexing.status, "done");
    assert.equal(all.indexing.found, 4);

    // Folder picker, then only "Music".
    const root = (await app.inject({ method: "GET", url: "/api/onedrive-gdrive/google/folders", headers: alice })).json() as { folders: { id: string; name: string }[] };
    assert.deepEqual(root.folders.map((f) => f.name), ["Music", "Podcasts"]);
    const sub = (await app.inject({ method: "GET", url: `/api/onedrive-gdrive/google/folders?parent=${ids.music}`, headers: alice })).json() as { folders: { name: string }[] };
    assert.deepEqual(sub.folders.map((f) => f.name), ["Night Owls"]);
    const put = await app.inject({ method: "PUT", url: "/api/onedrive-gdrive/google/folders", headers: alice, payload: { folders: [{ id: ids.music, name: "Music" }] } });
    assert.equal(put.statusCode, 200);
    await new Promise((r) => setTimeout(r, 80));
    const some = await indexNow(app, alice, "google");
    assert.equal(some.trackCount, 2);
    const list = await tracks(app, alice, "google");
    assert.deepEqual(list.items.map((t) => t.title), ["Blue Hour", "Moth"]);
    assert.equal(list.items[0]!.location, "Music/Night Owls/01 Blue Hour.mp3");

    const moth = list.items[1]!;
    const link = (await app.inject({ method: "GET", url: `/api/onedrive-gdrive/google/tracks/${moth.id}/stream-url`, headers: alice })).json() as { path: string };
    const data = [...cloud.nodes.get("google")!.values()].find((n) => n.name === "02 Moth.mp3")!.data!;
    const whole = await app.inject({ method: "GET", url: "/" + link.path });
    assert.equal(whole.statusCode, 200);
    assert.deepEqual(whole.rawPayload, data);
    const part = await app.inject({ method: "GET", url: "/" + link.path, headers: { range: "bytes=10-19" } });
    assert.equal(part.statusCode, 206);
    assert.deepEqual(part.rawPayload, data.subarray(10, 20));
    assert.equal((await app.inject({ method: "GET", url: "/" + link.path, headers: { range: "bytes=99999999-" } })).statusCode, 416);

    // Another person has nothing, and can't use this link as theirs.
    assert.equal((await tracks(app, bob, "google")).total, 0);
    assert.equal((await app.inject({ method: "GET", url: "/" + link.path.replace(/u=\d+/, "u=3") })).statusCode, 403);

    // Only read access was ever asked for.
    const consent = cloud.calls.filter((c) => c.kind === "api");
    assert.ok(consent.every((c) => c.method === "GET"), "only GET calls were made to the API");
  } finally {
    await app.close();
    await cloud.stop();
  }
});

test("OneDrive: the download hop gets no token but keeps the Range; rotated refresh tokens are saved", async () => {
  const cloud = await new FakeCloud().start();
  fill(cloud, "microsoft");
  let clock = Date.now();
  const { app, admin, alice } = await setup(cloud, { now: () => clock });
  try {
    await registerApps(app, admin, cloud);
    assert.equal((await signInTo(app, alice, cloud, "microsoft")).statusCode, 200);
    const first = await indexNow(app, alice, "microsoft");
    assert.equal(first.indexing.found, 4);
    const moth = (await tracks(app, alice, "microsoft", "?q=Moth")).items[0]!;
    const link = (await app.inject({ method: "GET", url: `/api/onedrive-gdrive/microsoft/tracks/${moth.id}/stream-url`, headers: alice })).json() as { path: string };
    const data = [...cloud.nodes.get("microsoft")!.values()].find((n) => n.name === "02 Moth.mp3")!.data!;

    cloud.calls.length = 0;
    const part = await app.inject({ method: "GET", url: "/" + link.path, headers: { range: "bytes=100-299" } });
    assert.equal(part.statusCode, 206);
    assert.equal(part.headers["content-range"], `bytes 100-299/${data.length}`);
    assert.deepEqual(part.rawPayload, data.subarray(100, 300));
    const download = cloud.calls.find((c) => c.kind === "download")!;
    assert.ok(download, "the redirect was followed");
    assert.equal(download.authorization, undefined, "the access token is not sent to the download host");
    assert.ok(download.host?.startsWith("localhost"), "the download came from a different origin");
    assert.equal(download.range, "bytes=100-299");
    assert.match(cloud.calls.find((c) => c.path.includes("/content"))!.authorization ?? "", /^Bearer /);

    // An hour later the access token is old: the refresh token is used, and the rotated one is kept for next time.
    clock += 2 * 3600_000;
    cloud.expireAccessTokens();
    assert.equal((await app.inject({ method: "GET", url: "/" + link.path })).statusCode, 200);
    clock += 2 * 3600_000;
    cloud.expireAccessTokens();
    assert.equal((await app.inject({ method: "GET", url: "/" + link.path })).statusCode, 200);
    assert.equal(cloud.calls.filter((c) => c.kind === "token").length, 2, "one refresh per expiry, not per request");
  } finally {
    await app.close();
    await cloud.stop();
  }
});

test("an access token that stops working is refreshed and the call retried once", async () => {
  const cloud = await new FakeCloud().start();
  fill(cloud, "google");
  const { app, admin, alice } = await setup(cloud);
  try {
    await registerApps(app, admin, cloud);
    await signInTo(app, alice, cloud, "google");
    cloud.expireAccessTokens(); // the service says 401 although our clock thinks the token is fine
    const res = await indexNow(app, alice, "google");
    assert.equal(res.indexing.status, "done");
    assert.equal(res.indexing.found, 4);
    assert.ok(cloud.calls.some((c) => c.kind === "token" && c.path.endsWith("/token")), "a refresh happened");
  } finally {
    await app.close();
    await cloud.stop();
  }
});

test("a revoked sign-in turns into 'connect again'; the cached library is kept and nothing is removed", async () => {
  const cloud = await new FakeCloud().start();
  fill(cloud, "google");
  const { app, admin, alice } = await setup(cloud);
  try {
    await registerApps(app, admin, cloud);
    await signInTo(app, alice, cloud, "google");
    await indexNow(app, alice, "google");
    cloud.revokeRefreshTokens("google");
    cloud.expireAccessTokens();
    const run = await indexNow(app, alice, "google");
    assert.equal(run.indexing.status, "failed");
    assert.equal(run.indexing.error, "needs_reconnect");
    assert.equal(run.trackCount, 4, "the cache survives");
    const status = (await app.inject({ method: "GET", url: "/api/onedrive-gdrive/status", headers: alice })).json() as { google: { connected: boolean; needsReconnect: boolean } };
    assert.deepEqual([status.google.connected, status.google.needsReconnect], [false, true]);
    // Signing in again fixes it.
    assert.equal((await signInTo(app, alice, cloud, "google")).statusCode, 200);
    const again = (await app.inject({ method: "GET", url: "/api/onedrive-gdrive/status", headers: alice })).json() as { google: { connected: boolean; needsReconnect: boolean } };
    assert.deepEqual([again.google.connected, again.google.needsReconnect], [true, false]);
  } finally {
    await app.close();
    await cloud.stop();
  }
});

test("the sign-in callback rejects forged, expired, replayed and mismatched requests", async () => {
  const cloud = await new FakeCloud().start();
  let clock = 1_800_000_000_000;
  const { app, admin, alice } = await setup(cloud, { now: () => clock });
  try {
    await registerApps(app, admin, cloud);
    const callback = (q: string) => app.inject({ method: "GET", url: `/api/onedrive-gdrive/callback?${q}` });
    assert.equal((await callback("code=x&state=nope")).statusCode, 400);
    assert.equal((await callback("code=x")).statusCode, 400);
    const forged = makeState("t".repeat(64), "google", 2, Math.floor(clock / 1000));
    assert.equal((await callback(`code=x&state=${encodeURIComponent(forged.state)}`)).statusCode, 400, "signed with another secret");

    const start = (await app.inject({ method: "POST", url: "/api/onedrive-gdrive/google/authorize", headers: alice })).json() as { url: string };
    const { code, state } = cloud.consent("google", start.url);
    const [body, sig] = state.split(".");
    const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), u: 3 })).toString("base64url");
    assert.equal((await callback(`code=${code}&state=${tampered}.${sig}`)).statusCode, 400, "changed user id");

    clock += 11 * 60_000;
    assert.equal((await callback(`code=${code}&state=${encodeURIComponent(state)}`)).statusCode, 400, "expired");
    clock -= 11 * 60_000;
    assert.equal((await callback(`error=access_denied&state=${encodeURIComponent(state)}`)).statusCode, 400, "the person said no");

    assert.equal((await callback(`code=${code}&state=${encodeURIComponent(state)}`)).statusCode, 200);
    const replay = await callback(`code=${code}&state=${encodeURIComponent(state)}`);
    assert.equal(replay.statusCode, 502, "a code works once");
    assert.ok(!replay.body.includes(code));

    // A state made for Google can't be used to attach a Microsoft account.
    const ms = (await app.inject({ method: "POST", url: "/api/onedrive-gdrive/microsoft/authorize", headers: alice })).json() as { url: string };
    const msConsent = cloud.consent("microsoft", ms.url);
    const mixed = await callback(`code=${msConsent.code}&state=${encodeURIComponent(state)}`);
    assert.notEqual(mixed.statusCode, 200);
  } finally {
    await app.close();
    await cloud.stop();
  }
});

test("state values bind user and provider, expire, and derive a stable PKCE verifier", () => {
  const now = 1_000_000;
  const s = makeState(SECRET, "microsoft", 7, now);
  const read = readState(SECRET, s.state, now + 5)!;
  assert.equal(read.p, "microsoft");
  assert.equal(read.u, 7);
  assert.equal(read.verifier, s.verifier);
  assert.equal(read.verifier, verifierFor(SECRET, JSON.parse(Buffer.from(s.state.split(".")[0]!, "base64url").toString()).n));
  assert.ok(s.verifier.length >= 43 && s.verifier.length <= 128, "RFC 7636 length");
  assert.equal(readState(SECRET, s.state, now + 601), null);
  assert.equal(readState("x".repeat(64), s.state, now), null);
  // Change the last signature character to a different one (a fixed "A" was a no-op whenever it already was "A": 1 run in 64).
  const last = s.state.slice(-1);
  assert.equal(readState(SECRET, s.state.slice(0, -1) + (last === "A" ? "B" : "A"), now), null);
  assert.notEqual(makeState(SECRET, "microsoft", 7, now).state, s.state);
});

test("folder ids are validated before they go into any request", async () => {
  const cloud = await new FakeCloud().start();
  fill(cloud, "google");
  const { app, admin, alice } = await setup(cloud);
  try {
    await registerApps(app, admin, cloud);
    await signInTo(app, alice, cloud, "google");
    const evil = ["x' or '1'='1", "a/../b", "id with space", "abcd", ""];
    for (const id of evil) {
      const res = await app.inject({ method: "PUT", url: "/api/onedrive-gdrive/google/folders", headers: alice, payload: { folders: [{ id, name: "x" }] } });
      assert.equal(res.statusCode, 400, id);
    }
    assert.equal((await app.inject({ method: "GET", url: `/api/onedrive-gdrive/google/folders?parent=${encodeURIComponent("x' or '1'='1")}`, headers: alice })).statusCode, 400);
    assert.equal((await app.inject({ method: "PUT", url: "/api/onedrive-gdrive/google/folders", headers: alice, payload: { folders: [{ id: "root", name: "x" }] } })).statusCode, 400, "the whole drive is the default, not a folder");
    assert.ok(!cloud.calls.some((c) => c.path.includes("or%20")), "nothing malicious reached the API");
  } finally {
    await app.close();
    await cloud.stop();
  }
});

test("a next-page link pointing at another host is not followed", async () => {
  const cloud = await new FakeCloud().start();
  fill(cloud, "microsoft");
  const hits: string[] = [];
  const other = http.createServer((req, res) => {
    hits.push(`${req.url} ${req.headers.authorization ?? ""}`);
    res.end("{}");
  });
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  cloud.evilNextLink = `http://127.0.0.1:${(other.address() as AddressInfo).port}/steal`;
  const { app, admin, alice } = await setup(cloud);
  try {
    await registerApps(app, admin, cloud);
    await signInTo(app, alice, cloud, "microsoft");
    const run = await indexNow(app, alice, "microsoft");
    assert.equal(run.indexing.status, "failed");
    assert.deepEqual(hits, [], "the other host never saw a request (or the token)");
  } finally {
    await app.close();
    await cloud.stop();
    await new Promise<void>((r) => other.close(() => r()));
  }
});

test("switching to another account clears the old account's tracks; disconnecting forgets everything", async () => {
  const cloud = await new FakeCloud().start();
  fill(cloud, "google");
  const { app, db, admin, alice } = await setup(cloud);
  try {
    await registerApps(app, admin, cloud);
    await signInTo(app, alice, cloud, "google");
    await indexNow(app, alice, "google");
    assert.equal((await tracks(app, alice, "google")).total, 4);

    cloud.accounts.google = "someone.else@gmail.example";
    await signInTo(app, alice, cloud, "google");
    await new Promise((r) => setTimeout(r, 50));
    const after = (await app.inject({ method: "GET", url: "/api/onedrive-gdrive/status", headers: alice })).json() as { google: { account: string } };
    assert.equal(after.google.account, "someone.else@gmail.example");

    assert.equal((await app.inject({ method: "DELETE", url: "/api/onedrive-gdrive/google/connection", headers: alice })).statusCode, 204);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM source_tracks WHERE source = 'gdrive'"), 0);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'plugin:cadence.onedrive-gdrive:user:%'"), 0);
    assert.equal((await app.inject({ method: "POST", url: "/api/onedrive-gdrive/google/index", headers: alice })).statusCode, 409);
  } finally {
    await app.close();
    await cloud.stop();
  }
});
