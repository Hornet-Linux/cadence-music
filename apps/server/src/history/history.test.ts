import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthResponse, HistoryResponse, Play, TopTracksResponse } from "@uma/shared";
import { buildApp } from "../app.js";
import { openDb } from "../db.js";
import { createLocalUser } from "../auth/users.js";
import { sanitizePlay } from "./plugin.js";

const track = (id: string, title = id) => ({
  id,
  title,
  artists: [{ id: "a1", name: "Artist" }],
  album: "Album",
  artwork: "https://i.scdn.co/image/abc",
  durationSec: 200,
  source: "spotify",
});

test("sanitizePlay keeps good plays and rejects junk", () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(sanitizePlay({ track: track("spotify:track:1"), playedAt: now }, now)?.track.id, "spotify:track:1");
  assert.equal(sanitizePlay({ track: { id: "x" }, playedAt: now }, now), null, "title required");
  assert.equal(sanitizePlay({ track: track("x"), playedAt: now + 3_600_000 }, now), null, "no future plays");
  assert.equal(sanitizePlay({ track: track("x"), playedAt: "yesterday" }, now), null);
  assert.equal(sanitizePlay(null, now), null);
  const sneaky = sanitizePlay({ track: { ...track("x"), artwork: "javascript:alert(1)" }, playedAt: now }, now);
  assert.equal(sneaky?.track.artwork, undefined, "only https artwork is stored");
});

test("records history, lists it newest first and ranks top tracks per user", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-hist-"));
  const db = openDb(":memory:");
  await createLocalUser(db, { username: "alice", password: "alice-password" });
  await createLocalUser(db, { username: "bob", password: "bob-password" });
  const app = await buildApp({
    config: {
      host: "127.0.0.1",
      port: 0,
      dataDir: dir,
      musicDir: dir,
      scanIntervalMinutes: 0,
      trustProxy: false,
      logLevel: "silent",
    },
    db,
    secret: "s".repeat(64),
    logger: false,
  });
  const signIn = async (username: string, password: string) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
    return { authorization: `Bearer ${(res.json() as AuthResponse).token}` };
  };
  const alice = await signIn("alice", "alice-password");
  const bob = await signIn("bob", "bob-password");

  assert.equal((await app.inject({ method: "GET", url: "/api/me/history" })).statusCode, 401);

  const base = Date.now() - 60_000;
  const plays: Play[] = [
    { track: track("spotify:track:a", "Song A"), playedAt: base },
    { track: track("spotify:track:b", "Song B"), playedAt: base + 1000 },
    { track: track("spotify:track:a", "Song A"), playedAt: base + 2000 },
    { track: track("apple:song:c", "Song C"), playedAt: base + 3000 },
    { track: track("spotify:track:a", "Song A (Remastered)"), playedAt: base + 4000 },
  ];
  const record = await app.inject({
    method: "POST",
    url: "/api/me/history",
    headers: alice,
    payload: { plays: [...plays, { track: { id: "bad" }, playedAt: base }] },
  });
  assert.deepEqual(record.json(), { stored: 5, rejected: 1 });

  // Re-uploading the same plays (e.g. after reconnecting) does not duplicate them.
  const again = await app.inject({ method: "POST", url: "/api/me/history", headers: alice, payload: { plays } });
  assert.equal(again.json().stored, 0);

  const history = (await app.inject({ method: "GET", url: "/api/me/history?limit=3", headers: alice }))
    .json() as HistoryResponse;
  assert.deepEqual(
    history.items.map((p) => p.track.title),
    ["Song A (Remastered)", "Song C", "Song A"],
  );
  assert.equal(history.items[0].track.artists[0].name, "Artist");

  const top = (await app.inject({ method: "GET", url: "/api/me/top", headers: alice })).json() as TopTracksResponse;
  assert.equal(top.items[0].track.id, "spotify:track:a");
  assert.equal(top.items[0].plays, 3);
  assert.equal(top.items[0].track.title, "Song A (Remastered)", "latest metadata wins");
  assert.equal(top.items.length, 3);

  // History is private to each user.
  const bobs = (await app.inject({ method: "GET", url: "/api/me/history", headers: bob })).json() as HistoryResponse;
  assert.equal(bobs.items.length, 0);

  const tooMany = await app.inject({
    method: "POST",
    url: "/api/me/history",
    headers: alice,
    payload: { plays: Array.from({ length: 201 }, (_, i) => ({ track: track(`t${i}`), playedAt: base })) },
  });
  assert.equal(tooMany.statusCode, 400);

  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
