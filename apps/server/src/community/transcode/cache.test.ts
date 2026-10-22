import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cacheKey, cacheUsage, evictCache } from "./cache.js";
import { alreadySmall, PROFILES, profileById } from "./profiles.js";

function folder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cadence-cache-"));
}

function put(dir: string, name: string, bytes: number, ageMinutes: number) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  const t = new Date(Date.now() - ageMinutes * 60_000);
  fs.utimesSync(file, t, t);
}

test("eviction removes the least recently used files until the cache fits", async () => {
  const dir = folder();
  try {
    put(dir, "old.opus", 400, 300);
    put(dir, "mid.opus", 400, 200);
    put(dir, "new.opus", 400, 10);
    const result = await evictCache(dir, 900);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["mid.opus", "new.opus"]);
    assert.equal(result.removed, 1);
    assert.equal(result.freedBytes, 400);
    assert.equal(result.remainingBytes, 800);
    assert.equal((await evictCache(dir, 900)).removed, 0, "nothing to do when under the cap");
    await evictCache(dir, 0);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("eviction keeps files in use and fresh partial files, and sweeps stale partial ones", async () => {
  const dir = folder();
  try {
    put(dir, "busy.opus", 500, 500);
    put(dir, "other.opus", 500, 100);
    put(dir, "live.opus.part", 500, 5);
    put(dir, "crashed.opus.part", 500, 600);
    const result = await evictCache(dir, 100, new Set(["busy.opus", "live.opus.part"]));
    assert.deepEqual(fs.readdirSync(dir).sort(), ["busy.opus", "live.opus.part"]);
    assert.equal(result.removed, 2, "the unused file and the stale partial file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("eviction and usage cope with a missing folder", async () => {
  const gone = path.join(os.tmpdir(), "cadence-cache-does-not-exist");
  assert.deepEqual(await evictCache(gone, 10), { removed: 0, freedBytes: 0, remainingBytes: 0, remainingFiles: 0 });
  assert.deepEqual(await cacheUsage(gone), { files: 0, bytes: 0 });
});

test("cache keys change with the file, its version and the profile", () => {
  const a = cacheKey("t1", 100, 5, "opus-96");
  assert.equal(a, cacheKey("t1", 100, 5, "opus-96"));
  assert.notEqual(a, cacheKey("t1", 101, 5, "opus-96"), "a changed file is a new entry");
  assert.notEqual(a, cacheKey("t1", 100, 6, "opus-96"));
  assert.notEqual(a, cacheKey("t1", 100, 5, "opus-128"));
});

test("profiles are well formed, and already-small lossy files are not re-encoded", () => {
  assert.ok(profileById("opus-96") && profileById("aac-128") && profileById("mp3-192"));
  assert.equal(profileById("flac-9000"), undefined);
  assert.equal(new Set(PROFILES.map((p) => p.id)).size, PROFILES.length);
  const opus96 = profileById("opus-96")!;
  assert.equal(alreadySmall(".mp3", 1_000_000, 100, opus96), true, "80 kbps mp3 is below 96");
  assert.equal(alreadySmall(".mp3", 4_000_000, 100, opus96), false, "320 kbps mp3 is worth converting");
  assert.equal(alreadySmall(".flac", 100_000, 100, opus96), false, "lossless is always converted");
  assert.equal(alreadySmall(".mp3", 100, null, opus96), false, "unknown length: convert");
});