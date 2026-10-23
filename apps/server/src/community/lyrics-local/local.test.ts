import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthResponse } from "@uma/shared";
import { buildApp } from "../../app.js";
import { createLocalUser } from "../../auth/users.js";
import { openDb } from "../../db.js";
import plugin, { findLocalLyrics, syncTextToLrc } from "./plugin.js";

function library() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-lyl-"));
  fs.mkdirSync(path.join(dir, "Artist"));
  fs.writeFileSync(path.join(dir, "Artist", "with-lrc.mp3"), "not really audio");
  fs.writeFileSync(path.join(dir, "Artist", "with-lrc.lrc"), "[00:01.00]hello\n[00:02.00]world");
  fs.writeFileSync(path.join(dir, "Artist", "with-txt.mp3"), "x");
  fs.writeFileSync(path.join(dir, "Artist", "with-txt.txt"), "plain words");
  fs.writeFileSync(path.join(dir, "Artist", "bare.mp3"), "x");
  return dir;
}

test("finds a sibling .lrc, then a .txt, and nothing for a bare file", async () => {
  const dir = library();
  assert.deepEqual(await findLocalLyrics(path.join(dir, "Artist", "with-lrc.mp3")), {
    lrc: "[00:01.00]hello\n[00:02.00]world",
    from: "lrc-file",
  });
  assert.deepEqual(await findLocalLyrics(path.join(dir, "Artist", "with-txt.mp3")), { plain: "plain words", from: "txt-file" });
  assert.equal(await findLocalLyrics(path.join(dir, "Artist", "bare.mp3")), null);
});

test("ignores huge lyrics files", async () => {
  const dir = library();
  fs.writeFileSync(path.join(dir, "Artist", "bare.lrc"), "[00:01.00]" + "x".repeat(300 * 1024));
  assert.equal(await findLocalLyrics(path.join(dir, "Artist", "bare.mp3")), null);
});

test("formats embedded synced lyrics as LRC", () => {
  assert.equal(
    syncTextToLrc([{ text: "a", timestamp: 1500 }, { text: "b\nc", timestamp: 61230 }, { text: "no time" }]),
    "[00:01.50]a\n[01:01.23]b c",
  );
  assert.equal(syncTextToLrc([{ text: "x" }]), null);
});

test("the route needs a user, serves lyrics for known tracks, and 404s otherwise", async () => {
  const dir = library();
  const db = openDb(":memory:");
  await createLocalUser(db, { username: "alice", password: "alice-password" });
  const add = db.prepare("INSERT INTO tracks (id, rel_path, title, size, mtime_ms, added_at) VALUES (?, ?, ?, 1, 1, 1)");
  add.run("t1", "Artist/with-lrc.mp3", "A");
  add.run("t2", "Artist/bare.mp3", "B");
  add.run("t3", "../outside.mp3", "C");
  const app = await buildApp({
    config: { host: "127.0.0.1", port: 0, dataDir: dir, musicDir: dir, scanIntervalMinutes: 0, trustProxy: false, logLevel: "silent" },
    db,
    secret: "s".repeat(64),
    logger: false,
    plugins: [plugin],
  });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "alice", password: "alice-password" } });
  const headers = { authorization: `Bearer ${(login.json() as AuthResponse).token}` };

  assert.equal((await app.inject({ method: "GET", url: "/api/lyrics/local/t1" })).statusCode, 401);
  const ok = await app.inject({ method: "GET", url: "/api/lyrics/local/t1", headers });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().from, "lrc-file");
  assert.equal((await app.inject({ method: "GET", url: "/api/lyrics/local/t2", headers })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/api/lyrics/local/unknown", headers })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/api/lyrics/local/t3", headers })).statusCode, 404);
  await app.close();
});

function id3Frame(id: string, body: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length);
  return Buffer.concat([Buffer.from(id, "latin1"), size, Buffer.from([0, 0]), body]);
}

/** A tiny MP3 whose tags hold the given unsynchronised lyrics (ID3v2.3 USLT). */
function mp3WithLyrics(text: string): Buffer {
  const uslt = id3Frame("USLT", Buffer.concat([Buffer.from([0]), Buffer.from("eng\0", "latin1"), Buffer.from(text, "latin1")]));
  const title = id3Frame("TIT2", Buffer.concat([Buffer.from([0]), Buffer.from("Song", "latin1")]));
  const tags = Buffer.concat([title, uslt]);
  const n = tags.length;
  const header = Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([3, 0, 0, (n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127])]);
  const audio = Buffer.alloc(417 * 4);
  for (let i = 0; i < 4; i++) audio.set([0xff, 0xfb, 0x90, 0x00], i * 417);
  return Buffer.concat([header, tags, audio]);
}

test("reads lyrics saved in the audio file tags", async () => {
  const dir = library();
  fs.writeFileSync(path.join(dir, "Artist", "tagged.mp3"), mp3WithLyrics("la la\nlo lo"));
  assert.deepEqual(await findLocalLyrics(path.join(dir, "Artist", "tagged.mp3")), { plain: "la la\nlo lo", from: "embedded" });
});
