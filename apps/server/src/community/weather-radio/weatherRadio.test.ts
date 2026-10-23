import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthResponse } from "@uma/shared";
import { buildApp } from "../../app.js";
import { openDb } from "../../db.js";
import { createLocalUser } from "../../auth/users.js";
import plugin from "./plugin.js";
import { cleanTags, TagIndexer, type FileTags } from "./tags.js";

test("tag lists are cleaned: split, trimmed, de-duplicated and capped", () => {
  assert.deepEqual(cleanTags({ genres: ["Jazz; Blues", " jazz ", "", 7, "Lo-Fi/Chill"], bpm: 119.6 }), {
    genres: ["Jazz", "Blues", "Lo-Fi", "Chill"],
    bpm: 120,
  });
  assert.deepEqual(cleanTags({ genres: "nope", bpm: 9000 }), { genres: [], bpm: undefined });
  assert.equal(cleanTags({ genres: Array.from({ length: 30 }, (_, i) => `g${i}`) }).genres.length, 8);
});

function seedTracks(db: ReturnType<typeof openDb>, rows: [string, string, number][]) {
  for (const [id, rel, mtime] of rows) {
    db.prepare("INSERT INTO tracks (id, rel_path, title, size, mtime_ms, added_at) VALUES (?, ?, ?, 1, ?, 1)").run(id, rel, rel, mtime);
  }
}

test("the indexer reads each file once, re-reads changed ones and forgets removed ones", async () => {
  const db = openDb(":memory:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-wr-"));
  seedTracks(db, [
    ["a", "one.mp3", 10],
    ["b", "sub/two.mp3", 10],
    ["c", "three.mp3", 10],
  ]);
  const reads: string[] = [];
  const tags: Record<string, FileTags> = {
    "one.mp3": { genres: ["Jazz"], bpm: 90 },
    "sub/two.mp3": { genres: [] },
    "three.mp3": { genres: ["Rock"] },
  };
  const reader = async (file: string): Promise<FileTags> => {
    const rel = path.relative(dir, file).split(path.sep).join("/");
    reads.push(rel);
    if (rel === "three.mp3") throw new Error("unreadable");
    return tags[rel];
  };
  const indexer = new TagIndexer(db, dir, reader);
  assert.equal(indexer.countPending(), 3);
  assert.equal(await indexer.run(2), 2, "works in batches");
  assert.equal(indexer.countPending(), 1);
  assert.equal(await indexer.run(10), 1);
  assert.equal(indexer.countPending(), 0);
  assert.equal(await indexer.run(10), 0, "nothing left to read");

  // Only tracks with something to say are listed. The unreadable file counts as done but has no tags.
  assert.deepEqual(indexer.list(), [{ id: "a", genres: ["Jazz"], bpm: 90 }]);

  // A changed file is read again; a removed track is forgotten.
  db.prepare("UPDATE tracks SET mtime_ms = 20 WHERE id = 'a'").run();
  tags["one.mp3"] = { genres: ["Soul"] };
  db.prepare("DELETE FROM tracks WHERE id = 'b'").run();
  assert.equal(await indexer.run(10), 1);
  assert.deepEqual(indexer.list(), [{ id: "a", genres: ["Soul"] }]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM wr_tags").get() as { n: number }).n, 2);
  assert.deepEqual(reads.filter((r) => r === "one.mp3").length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
  db.close();
});

test("a path that escapes the music folder is never read", async () => {
  const db = openDb(":memory:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-wr-"));
  seedTracks(db, [["x", "../outside.mp3", 1]]);
  let called = false;
  const indexer = new TagIndexer(db, dir, async () => {
    called = true;
    return { genres: ["Nope"] };
  });
  await indexer.run();
  assert.equal(called, false);
  assert.deepEqual(indexer.list(), []);
  fs.rmSync(dir, { recursive: true, force: true });
  db.close();
});

test("the tags route needs a sign-in and lists the indexed genres", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-wr-"));
  const db = openDb(":memory:");
  await createLocalUser(db, { username: "alice", password: "alice-password" });
  seedTracks(db, [["a", "one.mp3", 1]]);
  new TagIndexer(db, dir, async () => ({ genres: ["Ambient"], bpm: 70 })).run().then(() => undefined);
  const app = await buildApp({
    config: { host: "127.0.0.1", port: 0, dataDir: dir, musicDir: dir, scanIntervalMinutes: 0, trustProxy: false, logLevel: "silent" },
    db,
    secret: "s".repeat(64),
    logger: false,
    plugins: [plugin],
  });
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/weather-radio/tags" })).statusCode, 401);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "alice", password: "alice-password" } });
    const headers = { authorization: `Bearer ${(login.json() as AuthResponse).token}` };
    // Let the indexing finish.
    await new Promise((r) => setTimeout(r, 50));
    const res = await app.inject({ method: "GET", url: "/api/weather-radio/tags", headers });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { items: [{ id: "a", genres: ["Ambient"], bpm: 70 }], pending: 0 });
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});