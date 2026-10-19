import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthResponse, LikesResponse, PlaylistResponse, PlaylistsResponse } from "@uma/shared";
import { buildApp } from "../app.js";
import { openDb } from "../db.js";
import { createLocalUser } from "../auth/users.js";

const track = (id: string, title = id) => ({
  id,
  title,
  artists: [{ id: "a1", name: "Artist" }],
  album: "Album",
  artwork: "https://i.scdn.co/image/abc",
  durationSec: 200,
  source: "spotify",
});

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-coll-"));
  const db = openDb(":memory:");
  createLocalUser(db, { username: "alice", password: "alice-password" });
  createLocalUser(db, { username: "bob", password: "bob-password" });
  const app = await buildApp({
    config: { host: "127.0.0.1", port: 0, dataDir: dir, musicDir: dir, scanIntervalMinutes: 0, trustProxy: false, logLevel: "silent" },
    db,
    secret: "s".repeat(64),
    logger: false,
    onSetupCode: () => undefined,
  });
  const as = async (username: string, password: string) => {
    const { token } = (
      await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } })
    ).json() as AuthResponse;
    return (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
      app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  };
  const close = async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { app, as, close };
}

test("likes are per person, newest first, and can be removed", async () => {
  const { app, as, close } = await setup();
  const alice = await as("alice", "alice-password");
  const bob = await as("bob", "bob-password");

  assert.equal((await app.inject({ method: "GET", url: "/api/me/likes" })).statusCode, 401);
  assert.equal((await alice("POST", "/api/me/likes", { track: { id: "x" } })).statusCode, 400);
  assert.equal((await alice("POST", "/api/me/likes", { track: track("spotify:track:1"), likedAt: 1000 })).statusCode, 204);
  assert.equal((await alice("POST", "/api/me/likes", { track: track("server:a/b c"), likedAt: 2000 })).statusCode, 204);
  // Liking again is fine and doesn't duplicate.
  assert.equal((await alice("POST", "/api/me/likes", { track: track("spotify:track:1") })).statusCode, 204);

  const likes = (await alice("GET", "/api/me/likes")).json() as LikesResponse;
  assert.deepEqual(
    likes.items.map((i) => i.track.id),
    ["server:a/b c", "spotify:track:1"],
  );
  assert.equal(((await bob("GET", "/api/me/likes")).json() as LikesResponse).items.length, 0);

  await alice("DELETE", `/api/me/likes?trackId=${encodeURIComponent("server:a/b c")}`);
  assert.deepEqual(
    ((await alice("GET", "/api/me/likes")).json() as LikesResponse).items.map((i) => i.track.id),
    ["spotify:track:1"],
  );
  await close();
});

test("playlists can be created, renamed, edited and deleted only by their owner", async () => {
  const { as, close } = await setup();
  const alice = await as("alice", "alice-password");
  const bob = await as("bob", "bob-password");

  assert.equal((await alice("POST", "/api/me/playlists", { name: "   " })).statusCode, 400);
  const created = await alice("POST", "/api/me/playlists", { name: "Road trip", tracks: [track("t1"), { bad: 1 }] });
  assert.equal(created.statusCode, 201);
  const playlist = created.json() as PlaylistResponse;
  assert.equal(playlist.name, "Road trip");
  assert.deepEqual(
    playlist.tracks.map((t) => t.id),
    ["t1"],
    "invalid tracks are dropped",
  );

  const renamed = await alice("PATCH", `/api/me/playlists/${playlist.id}`, {
    name: "Summer",
    tracks: [track("t2"), track("t1")],
  });
  assert.equal(renamed.statusCode, 200);
  assert.deepEqual(
    (renamed.json() as PlaylistResponse).tracks.map((t) => t.id),
    ["t2", "t1"],
  );

  assert.equal((await bob("PATCH", `/api/me/playlists/${playlist.id}`, { name: "Mine now" })).statusCode, 404);
  assert.equal((await bob("DELETE", `/api/me/playlists/${playlist.id}`)).statusCode, 404);
  assert.equal(((await bob("GET", "/api/me/playlists")).json() as PlaylistsResponse).items.length, 0);

  const list = (await alice("GET", "/api/me/playlists")).json() as PlaylistsResponse;
  assert.deepEqual(
    list.items.map((p) => p.name),
    ["Summer"],
  );
  assert.equal((await alice("DELETE", `/api/me/playlists/${playlist.id}`)).statusCode, 204);
  assert.equal(((await alice("GET", "/api/me/playlists")).json() as PlaylistsResponse).items.length, 0);
  await close();
});
