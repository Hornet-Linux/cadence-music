import { test } from "node:test";
import assert from "node:assert/strict";
import type { Response as LightMyRequestResponse } from "light-my-request";
import { open } from "../../llm/secretBox.js";
import { fake, harness, SECRET, type Auth, type Harness } from "../_sourcekit/testkit.js";
import { AUDIO, COVER, FakeAbs, type FakeAbsOptions } from "./fakeAbs.js";
import { createAudiobooksPlugin } from "./plugin.js";
import { parseAbsUrl } from "./client.js";

const ANN = { username: "ann", password: "ann-pass" };
const BEN = { username: "ben", password: "ben-pass" };

interface Rig {
  h: Harness;
  abs: FakeAbs;
  call: (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, who: Auth | null, payload?: unknown, headers?: Record<string, string>) => Promise<LightMyRequestResponse>;
  connect: (who: Auth, creds?: { username: string; password: string }) => Promise<LightMyRequestResponse>;
  close: () => Promise<void>;
}

async function rig(opts: { configure?: boolean; abs?: FakeAbsOptions } = {}): Promise<Rig> {
  const h = await harness(() => createAudiobooksPlugin({ streamIdleMs: 2000, headerTimeoutMs: 3000 }));
  const abs = await new FakeAbs(opts.abs).start(h);
  const call: Rig["call"] = (method, url, who, payload, headers) =>
    h.app.inject({ method, url, headers: { ...(who ?? {}), ...(headers ?? {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  if (opts.configure !== false) {
    const res = await call("PUT", "/api/audiobooks/admin", h.admin, { serverUrl: abs.url + "/" });
    assert.equal(res.statusCode, 200, res.body);
  }
  return {
    h,
    abs,
    call,
    connect: (who, creds = ANN) => call("PUT", "/api/audiobooks/connection", who, creds),
    close: async () => {
      await h.close();
      await abs.stop();
    },
  };
}

test("admin sets the address: only admins, validated, and the test button checks /ping", async () => {
  const r = await rig({ configure: false });
  assert.deepEqual((await r.call("GET", "/api/audiobooks/status", r.h.alice)).json(), { configured: false, connected: false });
  assert.equal((await r.connect(r.h.alice)).statusCode, 409);
  assert.equal((await r.call("PUT", "/api/audiobooks/admin", r.h.alice, { serverUrl: r.abs.url })).statusCode, 403);
  for (const bad of ["ftp://x", "http://u:p@host", "http://host/?a=1", "not a url", "http://host#frag", ""]) {
    const res = await r.call("PUT", "/api/audiobooks/admin", r.h.admin, { serverUrl: bad });
    if (bad === "") assert.equal(res.statusCode, 200);
    else assert.equal(res.statusCode, 400, bad);
  }
  assert.throws(() => parseAbsUrl("http://x:1/a b"));
  assert.equal(parseAbsUrl(" http://abs.local:13378/audiobookshelf/ "), "http://abs.local:13378/audiobookshelf");
  const ok = await r.call("POST", "/api/audiobooks/admin/test", r.h.admin, { serverUrl: r.abs.url });
  assert.deepEqual(ok.json(), { ok: true });
  const dead = await r.call("POST", "/api/audiobooks/admin/test", r.h.admin, { serverUrl: "http://127.0.0.1:1" });
  assert.equal(dead.json().ok, false);
  assert.equal((await r.call("POST", "/api/audiobooks/admin/test", r.h.alice, { serverUrl: r.abs.url })).statusCode, 403);
  assert.equal((await r.call("PUT", "/api/audiobooks/admin", r.h.admin, { serverUrl: r.abs.url })).json().serverUrl, r.abs.url);
  assert.deepEqual((await r.call("GET", "/api/audiobooks/status", r.h.alice)).json(), { configured: true, connected: false });
  await r.close();
});

test("sign-in: each person uses their own account; tokens are encrypted and never returned", async () => {
  const r = await rig();
  const bad = await r.connect(r.h.alice, { username: "ann", password: "wrong" });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.json().error, "audiobooks_invalid_credentials");
  assert.ok(!bad.body.includes("Invalid username"), "no upstream text");
  const ok = await r.connect(r.h.alice);
  assert.deepEqual(ok.json(), { configured: true, connected: true, userName: "ann" });
  const token = [...r.abs.tokens.keys()][0];
  assert.ok(!ok.body.includes(token));
  const dump = JSON.stringify(r.h.db.prepare("SELECT * FROM audiobooks_connections").all());
  assert.ok(!dump.includes(token), "encrypted at rest");
  assert.ok(!dump.includes("ann-pass"), "password is never stored");
  const row = r.h.db.prepare("SELECT token_enc FROM audiobooks_connections").get() as { token_enc: string };
  assert.equal(open(row.token_enc, SECRET, "audiobookshelf-tokens"), token);
  assert.equal(open(row.token_enc, SECRET), null, "not readable as another kind of secret");

  // bob is a separate person: not connected just because alice is
  assert.deepEqual((await r.call("GET", "/api/audiobooks/status", r.h.bob)).json(), { configured: true, connected: false });
  assert.equal((await r.call("GET", "/api/audiobooks/libraries", r.h.bob)).json().error, "audiobooks_not_connected");
  assert.equal((await r.call("GET", "/api/audiobooks/libraries", null)).statusCode, 401);
  assert.equal((await r.connect(r.h.bob, BEN)).statusCode, 200);
  assert.deepEqual((await r.call("GET", "/api/audiobooks/status", r.h.bob)).json().userName, "ben");

  assert.equal((await r.call("DELETE", "/api/audiobooks/connection", r.h.alice)).statusCode, 204);
  assert.deepEqual((await r.call("GET", "/api/audiobooks/status", r.h.alice)).json(), { configured: true, connected: false });
  assert.deepEqual((await r.call("GET", "/api/audiobooks/status", r.h.bob)).json().connected, true);
  assert.equal((await r.connect(r.h.alice, { username: "", password: "x" })).statusCode, 400);
  await r.close();
});

test("sign-in attempts are rate limited", async () => {
  const r = await rig();
  for (let i = 0; i < 5; i++) assert.equal((await r.connect(r.h.alice, { username: "ann", password: "no" + i })).statusCode, 401);
  assert.equal((await r.connect(r.h.alice)).statusCode, 429, "even the right password waits");
  await r.close();
});

test("libraries, books, search, details with chapters and per-person progress", async () => {
  const r = await rig();
  await r.connect(r.h.alice);
  await r.connect(r.h.bob, BEN);
  const libs = (await r.call("GET", "/api/audiobooks/libraries", r.h.alice)).json() as { items: { id: string; name: string }[] };
  assert.deepEqual(libs.items, [{ id: "lib_books", name: "Books" }], "podcast libraries are left out");
  const list = (await r.call("GET", "/api/audiobooks/libraries/lib_books/items?limit=1&page=1", r.h.alice)).json() as { items: { id: string; title: string; author: string; cover: string; durationSec: number }[]; total: number };
  assert.equal(list.total, 2);
  assert.equal(list.items[0].title, "Second Book");
  assert.equal(list.items[0].author, "Bo Writer");
  assert.match(list.items[0].cover, /^api\/audiobooks\/cover\/li_two\?u=\d+&exp=\d+&sig=/);
  const found = (await r.call("GET", "/api/audiobooks/libraries/lib_books/items?q=first", r.h.alice)).json() as { items: { id: string }[] };
  assert.deepEqual(found.items.map((i) => i.id), ["li_one"]);
  assert.equal((await r.call("GET", "/api/audiobooks/libraries/bad%20id/items", r.h.alice)).statusCode, 400);

  const detail = (await r.call("GET", "/api/audiobooks/items/li_one", r.h.alice)).json();
  assert.equal(detail.title, "The First Book");
  assert.equal(detail.narrator, "Nora Narrator");
  assert.equal(detail.description, "A long story.");
  assert.deepEqual(detail.chapters, [{ index: 0, start: 0, end: 1200, title: "One" }, { index: 1, start: 1200, end: 3600, title: "Two" }]);
  assert.equal((await r.call("GET", "/api/audiobooks/items/nope", r.h.alice)).statusCode, 404);

  // progress is each person's own
  assert.equal((await r.call("PUT", "/api/audiobooks/items/li_one/progress", r.h.alice, { currentTime: 900, duration: 3600 })).statusCode, 204);
  const cont = (await r.call("GET", "/api/audiobooks/continue", r.h.alice)).json() as { items: { id: string; progress: { currentTime: number } }[] };
  assert.deepEqual(cont.items.map((i) => [i.id, i.progress.currentTime]), [["li_one", 900]]);
  assert.deepEqual(((await r.call("GET", "/api/audiobooks/continue", r.h.bob)).json() as { items: unknown[] }).items, []);
  assert.equal((await r.call("GET", "/api/audiobooks/items/li_one", r.h.bob)).json().progress, undefined);
  assert.equal((await r.call("GET", "/api/audiobooks/items/li_one", r.h.alice)).json().progress.currentTime, 900);
  assert.equal((await r.call("PUT", "/api/audiobooks/items/li_one/progress", r.h.alice, { currentTime: -5 })).statusCode, 400);
  // every upstream call used the signed-in person's own token
  const aliceToken = r.abs.log.find((l) => l.url.startsWith("/api/me/progress"))!.auth;
  assert.match(aliceToken!, /^Bearer tok-\d+-ann$/);
  assert.ok(r.abs.log.filter((l) => l.auth?.endsWith("-ben")).every((l) => !l.url.startsWith("/api/me/progress")));
  await r.close();
});

test("play: tracks stream through signed URLs with Range support, progress is reported back and resumes", async () => {
  const r = await rig();
  await r.connect(r.h.alice);
  await r.call("PUT", "/api/audiobooks/items/li_one/progress", r.h.alice, { currentTime: 1234.5, duration: 3600 });
  const play = await r.call("POST", "/api/audiobooks/items/li_one/play", r.h.alice);
  assert.equal(play.statusCode, 200, play.body);
  const s = play.json() as { sessionId: string; startTime: number; durationSec: number; chapters: unknown[]; tracks: { index: number; startOffset: number; durationSec: number; path: string }[] };
  assert.equal(s.startTime, 1234.5, "resumes where this person left off");
  assert.equal(s.durationSec, 3600);
  assert.equal(s.tracks.length, 2);
  assert.equal(s.tracks[1].startOffset, 1800);
  assert.ok(!play.body.includes("/public/session"), "Audiobookshelf's own track addresses stay on the server");
  assert.ok(!play.body.includes("tok-"));

  const full = await r.call("GET", `/${s.tracks[0].path}`, null);
  assert.equal(full.statusCode, 200);
  assert.equal(full.headers["content-type"], "audio/mpeg");
  assert.equal(full.rawPayload.equals(AUDIO), true);
  assert.match(r.abs.log.at(-1)!.auth!, /^Bearer tok-\d+-ann$/, "the person's token authorises the upstream stream");
  const part = await r.call("GET", `/${s.tracks[1].path}`, null, undefined, { range: "bytes=5-9" });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers["content-range"], `bytes 5-9/${AUDIO.length}`);
  assert.equal(part.payload, "FGHIJ");
  assert.equal(r.abs.log.at(-1)!.range, "bytes=5-9");
  assert.match(r.abs.log.at(-1)!.url, /track\/2$/);

  // signatures
  assert.equal((await r.call("GET", `/api/audiobooks/stream/${s.sessionId}/0`, null)).statusCode, 403);
  assert.equal((await r.call("GET", `/${s.tracks[0].path}`.replace("sig=", "sig=x"), null)).statusCode, 403);
  assert.equal((await r.call("GET", `/${s.tracks[0].path}`.replace("/0?", "/1?"), null)).statusCode, 403, "bound to the track");
  assert.equal((await r.call("GET", `/${s.tracks[0].path}`, r.h.bob)).statusCode, 200, "the URL itself is the credential; bob's bearer adds nothing");

  // progress goes back to Audiobookshelf
  assert.equal((await r.call("POST", `/api/audiobooks/sessions/${s.sessionId}/sync`, r.h.alice, { currentTime: 2000, timeListened: 15, duration: 3600 })).statusCode, 204);
  assert.deepEqual(r.abs.sessions.get(s.sessionId)!.syncs, [{ currentTime: 2000, timeListened: 15 }]);
  assert.equal((await r.call("POST", `/api/audiobooks/sessions/${s.sessionId}/sync`, r.h.alice, { currentTime: "x" })).statusCode, 400);
  assert.equal((await r.call("POST", `/api/audiobooks/sessions/${s.sessionId}/close`, r.h.alice, { currentTime: 2100, timeListened: 5 })).statusCode, 204);
  assert.equal(r.abs.sessions.get(s.sessionId)!.closed, true);
  assert.equal(r.abs.progress.get("ann")!.get("li_one")!.currentTime, 2100);
  const again = (await r.call("POST", "/api/audiobooks/items/li_one/play", r.h.alice)).json() as { startTime: number };
  assert.equal(again.startTime, 2100);
  // bob can't drive alice's session
  const bobSync = await r.call("POST", `/api/audiobooks/sessions/${s.sessionId}/sync`, r.h.bob, { currentTime: 5 });
  assert.equal(bobSync.statusCode, 409, "bob isn't signed in to Audiobookshelf");
  await r.connect(r.h.bob, BEN);
  const live = (await r.call("POST", "/api/audiobooks/items/li_one/play", r.h.alice)).json() as { sessionId: string };
  assert.equal((await r.call("POST", `/api/audiobooks/sessions/${live.sessionId}/sync`, r.h.bob, { currentTime: 5 })).statusCode, 404);
  await r.close();
});

test("play: when Audiobookshelf has lost the session, the position is saved directly and streaming says to restart", async () => {
  const r = await rig();
  await r.connect(r.h.alice);
  const s = (await r.call("POST", "/api/audiobooks/items/li_one/play", r.h.alice)).json() as { sessionId: string; tracks: { path: string }[] };
  r.abs.dropSessions = true;
  assert.equal((await r.call("POST", `/api/audiobooks/sessions/${s.sessionId}/sync`, r.h.alice, { currentTime: 777, duration: 3600 })).statusCode, 204);
  assert.equal(r.abs.progress.get("ann")!.get("li_one")!.currentTime, 777);
  assert.equal((await r.call("GET", `/${s.tracks[0].path}`, null)).statusCode, 404);
  // a session this server doesn't know about
  const stray = await r.call("GET", `/${s.tracks[0].path}`.replace(s.tracks[0].path.split("/")[3], "play-999"), null);
  assert.ok(stray.statusCode === 403 || stray.statusCode === 404);
  await r.close();
});

test("bookmarks: add, list, delete, per person", async () => {
  const r = await rig();
  await r.connect(r.h.alice);
  await r.connect(r.h.bob, BEN);
  assert.equal((await r.call("POST", "/api/audiobooks/items/li_one/bookmarks", r.h.alice, { time: 300.7, title: "Good part" })).statusCode, 201);
  assert.equal((await r.call("POST", "/api/audiobooks/items/li_one/bookmarks", r.h.alice, { time: 60, title: "Start" })).statusCode, 201);
  assert.equal((await r.call("POST", "/api/audiobooks/items/li_one/bookmarks", r.h.alice, { time: -1, title: "x" })).statusCode, 400);
  assert.equal((await r.call("POST", "/api/audiobooks/items/li_one/bookmarks", r.h.alice, { time: 5 })).statusCode, 400);
  const list = (await r.call("GET", "/api/audiobooks/items/li_one/bookmarks", r.h.alice)).json() as { items: { time: number; title: string }[] };
  assert.deepEqual(list.items.map((b) => [b.time, b.title]), [[60, "Start"], [300, "Good part"]]);
  assert.deepEqual(((await r.call("GET", "/api/audiobooks/items/li_one/bookmarks", r.h.bob)).json() as { items: unknown[] }).items, []);
  assert.equal((await r.call("DELETE", "/api/audiobooks/items/li_one/bookmarks/60", r.h.alice)).statusCode, 204);
  assert.equal((await r.call("DELETE", "/api/audiobooks/items/li_one/bookmarks/abc", r.h.alice)).statusCode, 400);
  assert.equal(((await r.call("GET", "/api/audiobooks/items/li_one/bookmarks", r.h.alice)).json() as { items: unknown[] }).items.length, 1);
  await r.close();
});

test("covers are proxied through signed URLs", async () => {
  const r = await rig();
  await r.connect(r.h.alice);
  const book = (await r.call("GET", "/api/audiobooks/items/li_one", r.h.alice)).json() as { cover: string };
  const img = await r.call("GET", `/${book.cover}`, null);
  assert.equal(img.statusCode, 200);
  assert.equal(img.headers["content-type"], "image/jpeg");
  assert.equal(img.rawPayload.equals(COVER), true);
  assert.equal((await r.call("GET", "/api/audiobooks/cover/li_one", null)).statusCode, 403);
  assert.equal((await r.call("GET", `/${book.cover}`.replace("li_one", "li_two"), null)).statusCode, 403);
  await r.close();
});

test("an expired access token is renewed with the refresh token, once", async () => {
  const r = await rig({ abs: { shortLivedTokens: 2 } });
  assert.equal((await r.connect(r.h.alice)).statusCode, 200);
  for (let i = 0; i < 4; i++) assert.equal((await r.call("GET", "/api/audiobooks/libraries", r.h.alice)).statusCode, 200, `call ${i}`);
  assert.ok(r.abs.log.some((l) => l.url === "/auth/refresh"));
  assert.equal(r.abs.log.filter((l) => l.url === "/login").length, 1, "no new sign-in needed");
  await r.close();
});

test("an expired or revoked sign-in is forgotten and reported", async () => {
  const r = await rig();
  await r.connect(r.h.alice);
  r.abs.tokens.clear();
  const res = await r.call("GET", "/api/audiobooks/libraries", r.h.alice);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "audiobooks_session_expired");
  assert.deepEqual((await r.call("GET", "/api/audiobooks/status", r.h.alice)).json(), { configured: true, connected: false });
  await r.close();
});

test("moving the server drops old sign-ins; a tampered or foreign track address is never fetched", async () => {
  const r = await rig();
  await r.connect(r.h.alice);
  const other = await fake(r.h, (_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: true })));
  assert.equal((await r.call("PUT", "/api/audiobooks/admin", r.h.admin, { serverUrl: other.url })).statusCode, 200);
  assert.deepEqual((await r.call("GET", "/api/audiobooks/status", r.h.alice)).json(), { configured: true, connected: false });
  assert.equal(other.seen.length, 0, "the old token was never sent to the new address");
  await other.close();
  await r.close();
});

test("redirects away from the Audiobookshelf server are not followed (the token would go with them)", async () => {
  const elsewhere = await fake(null, (_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ libraries: [] })));
  const h = await harness(() => createAudiobooksPlugin({ headerTimeoutMs: 2000 }));
  const abs = await fake(h, (req, res) => {
    if (req.url === "/login") return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ user: { id: "u1", username: "ann", token: "t1" } }));
    res.writeHead(302, { Location: elsewhere.url + "/api/libraries" }).end();
  });
  await h.app.inject({ method: "PUT", url: "/api/audiobooks/admin", headers: h.admin, payload: { serverUrl: abs.url } });
  await h.app.inject({ method: "PUT", url: "/api/audiobooks/connection", headers: h.alice, payload: ANN });
  const res = await h.app.inject({ method: "GET", url: "/api/audiobooks/libraries", headers: h.alice });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, "audiobooks_failed");
  assert.equal(elsewhere.seen.length, 0);
  await h.close();
  await abs.close();
  await elsewhere.close();
});