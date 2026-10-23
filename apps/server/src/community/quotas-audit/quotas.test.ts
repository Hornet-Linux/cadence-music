import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { StreamUrlResponse, TrackListResponse } from "@uma/shared";
import { openDb } from "../../db.js";
import { libraryPlugin } from "../../library/plugin.js";
import { makeApp, type TestApp } from "../_ops/testkit.js";
import { QuotaEngine, dayOf } from "./engine.js";
import { cleanConfig, createQuotasPlugin, limitsFor } from "./plugin.js";

function wav(samples: number): Buffer {
  const buf = Buffer.alloc(44 + samples);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(8000, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples, 40);
  buf.fill(128, 44);
  return buf;
}

const LIMITS = { maxConcurrentStreams: 1, maxHoursPerDay: 0 };

test("engine: the second device is refused, the same device may skip and seek", () => {
  let clock = Date.UTC(2026, 5, 1, 12, 0, 0);
  const engine = new QuotaEngine(openDb(":memory:"), () => clock);
  assert.deepEqual(engine.check(1, "phone", "t1", LIMITS), { ok: true });
  assert.equal(engine.start(1, "phone", "t1", 200), true);
  const refused = engine.check(1, "laptop", "t9", LIMITS);
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.reason, "concurrent");
  assert.ok(refused.ok === false && refused.retryAfterSec >= 5 && refused.retryAfterSec <= 200);
  // Same device: another range request for the same track, then the next track.
  assert.equal(engine.start(1, "phone", "t1", 200), false);
  assert.deepEqual(engine.check(1, "phone", "t2", LIMITS), { ok: true });
  assert.equal(engine.start(1, "phone", "t2", 100), true);
  assert.equal(engine.activeStreams(1), 1);
  // Someone else is not affected.
  assert.deepEqual(engine.check(2, "laptop", "t1", LIMITS), { ok: true });
  // After the track would have ended the other device may start.
  clock += 101_000;
  assert.equal(engine.activeStreams(1), 0);
  assert.deepEqual(engine.check(1, "laptop", "t9", LIMITS), { ok: true });
  // A limit of 2 admits two devices and refuses the third.
  engine.start(1, "a", "x", 500);
  engine.start(1, "b", "y", 500);
  assert.equal(engine.check(1, "c", "z", { maxConcurrentStreams: 2, maxHoursPerDay: 0 }).ok, false);
});

test("engine: the daily limit counts track lengths per UTC day and lets a started track finish", () => {
  let clock = Date.UTC(2026, 5, 1, 23, 0, 0);
  const engine = new QuotaEngine(openDb(":memory:"), () => clock);
  const limits = { maxConcurrentStreams: 0, maxHoursPerDay: 1 };
  engine.start(1, "d", "t1", 1800);
  clock += 1_900_000;
  assert.deepEqual(engine.check(1, "d", "t2", limits), { ok: true });
  engine.start(1, "d", "t2", 1800);
  assert.equal(engine.secondsToday(1), 3600);
  const next = engine.check(1, "d", "t3", limits);
  assert.equal(next.ok === false && next.reason, "daily");
  // The track in progress may continue (its next range request is not a new stream).
  assert.deepEqual(engine.check(1, "d", "t2", limits), { ok: true });
  // Midnight UTC resets it.
  clock = Date.UTC(2026, 5, 2, 0, 0, 5);
  assert.deepEqual(engine.check(1, "d", "t3", limits), { ok: true });
  assert.equal(engine.secondsToday(1), 0);
  assert.equal(dayOf(clock), "2026-06-02");
  // A track of unknown length counts as three minutes.
  engine.start(1, "d", "t4", null);
  assert.equal(engine.secondsToday(1), 180);
});

test("engine: usage per person and the event trail", () => {
  const clock = Date.UTC(2026, 5, 10, 12);
  const db = openDb(":memory:");
  db.exec("INSERT INTO users (id, username, created_at) VALUES (1, 'ana', 1), (2, 'ben', 1)");
  const engine = new QuotaEngine(db, () => clock);
  engine.start(1, "d", "t1", 100);
  engine.start(1, "d", "t2", 50);
  engine.deny(2, "concurrent", "t3");
  const [ana, ben] = engine.usage();
  assert.deepEqual([ana.today, ana.last7, ana.last30, ana.streams30], [150, 150, 150, 2]);
  assert.equal(ben.today, 0);
  assert.equal(ana.lastStreamAt, clock);
  assert.deepEqual(engine.events().map((e) => [e.username, e.kind]), [["ben", "denied:concurrent"], ["ana", "stream"], ["ana", "stream"]]);
});

test("config is cleaned and admins can be exempt", () => {
  const cfg = cleanConfig({ maxConcurrentStreams: 2.6, maxHoursPerDay: -4, overrides: { "5": { maxHoursPerDay: 99 }, x: { maxHoursPerDay: 1 } } });
  assert.equal(cfg.maxConcurrentStreams, 3);
  assert.equal(cfg.maxHoursPerDay, 0);
  assert.deepEqual(cfg.overrides, { "5": { maxHoursPerDay: 24 } });
  assert.equal(limitsFor(cfg, { id: 1, is_admin: 1 }), null);
  assert.deepEqual(limitsFor({ ...cfg, exemptAdmins: false }, { id: 1, is_admin: 1 }), { maxConcurrentStreams: 3, maxHoursPerDay: 0 });
  assert.deepEqual(limitsFor(cfg, { id: 5, is_admin: 0 }), { maxConcurrentStreams: 3, maxHoursPerDay: 24 });
});

async function withLibrary(run: (t: TestApp, ids: string[]) => Promise<void>) {
  const t = await makeApp([libraryPlugin, createQuotasPlugin()]);
  try {
    for (const name of ["a.wav", "b.wav", "c.wav"]) fs.writeFileSync(path.join(t.dir, name), wav(8000 + name.charCodeAt(0)));
    const scan = await t.app.inject({ method: "POST", url: "/api/library/scan?wait=1", headers: t.auth(t.adminToken) });
    assert.equal(scan.statusCode, 200);
    const list = (await t.app.inject({ method: "GET", url: "/api/tracks", headers: t.auth(t.userToken) })).json() as TrackListResponse;
    await run(t, list.items.map((i) => i.id));
  } finally {
    await t.cleanup();
  }
}

const streamUrl = (t: TestApp, id: string, token: string, ua: string) =>
  t.app.inject({ method: "GET", url: `/api/tracks/${id}/stream-url`, headers: { ...t.auth(token), "user-agent": ua } });

test("the real streaming routes: a second device is refused and a stream fetched with the signed address is counted", async () => {
  await withLibrary(async (t, ids) => {
    const admin = t.auth(t.adminToken);
    await t.app.inject({ method: "PUT", url: "/api/quotas/config", headers: admin, payload: { maxConcurrentStreams: 1 } });

    // Device A asks for a track, and plays it.
    const a = await streamUrl(t, ids[0], t.userToken, "PhoneBrowser/1");
    assert.equal(a.statusCode, 200);
    const signed = (a.json() as StreamUrlResponse).path;
    const played = await t.app.inject({ method: "GET", url: `/${signed.replace(/^\//, "")}`, headers: { "user-agent": "PhoneBrowser/1", range: "bytes=0-99" } });
    assert.equal(played.statusCode, 206);

    // Device B (another browser) is told no, with the standard 429 and a Retry-After.
    const b = await streamUrl(t, ids[1], t.userToken, "LaptopBrowser/2");
    assert.equal(b.statusCode, 429);
    assert.equal((b.json() as { error: string }).error, "quota_concurrent_streams");
    assert.ok(Number(b.headers["retry-after"]) >= 5);

    // Device A can carry on: skip to the next track, and seek in the current one.
    const next = await streamUrl(t, ids[1], t.userToken, "PhoneBrowser/1");
    assert.equal(next.statusCode, 200);
    const nextPlayed = await t.app.inject({ method: "GET", url: `/${(next.json() as StreamUrlResponse).path.replace(/^\//, "")}`, headers: { "user-agent": "PhoneBrowser/1" } });
    assert.equal(nextPlayed.statusCode, 200);

    // Admins are exempt by default.
    const c = await streamUrl(t, ids[2], t.adminToken, "AdminBox/1"); 
    assert.equal(c.statusCode, 200);
    // The listener's own view of their limits.
    const me = (await t.app.inject({ method: "GET", url: "/api/quotas/me", headers: t.auth(t.userToken) })).json() as { limits: { maxConcurrentStreams: number }; activeStreams: number };
    assert.equal(me.limits.maxConcurrentStreams, 1);
    assert.equal(me.activeStreams, 1);

    // The admin sees what was streamed and what was refused.
    const usage = (await t.app.inject({ method: "GET", url: "/api/quotas/usage", headers: admin })).json() as { items: { username: string; streams30: number; todaySeconds: number }[]; denied: { concurrent: number } };
    const listener = usage.items.find((u) => u.username === "listener")!;
    assert.equal(listener.streams30, 2);
    assert.ok(listener.todaySeconds >= 2);
    assert.equal(usage.denied.concurrent, 1);
    const events = (await t.app.inject({ method: "GET", url: "/api/quotas/events", headers: admin })).json() as { items: { kind: string }[] };
    assert.ok(events.items.some((e) => e.kind === "denied:concurrent"));
    assert.equal((await t.app.inject({ method: "GET", url: "/api/quotas/usage", headers: t.auth(t.userToken) })).statusCode, 403);
  });
});

test("the real streaming routes: the daily hours limit stops new tracks but not the one in progress", async () => {
  await withLibrary(async (t, ids) => {
    const admin = t.auth(t.adminToken);
    t.db.prepare("UPDATE tracks SET duration_sec = 1800").run();
    await t.app.inject({ method: "PUT", url: "/api/quotas/config", headers: admin, payload: { maxHoursPerDay: 1 } });
    for (const id of ids.slice(0, 2)) {
      const url = await streamUrl(t, id, t.userToken, "Same/1");
      assert.equal(url.statusCode, 200);
      const res = await t.app.inject({ method: "GET", url: `/${(url.json() as StreamUrlResponse).path.replace(/^\//, "")}`, headers: { "user-agent": "Same/1" } });
      assert.equal(res.statusCode, 200);
    }
    const third = await streamUrl(t, ids[2], t.userToken, "Same/1");
    assert.equal(third.statusCode, 429);
    assert.equal((third.json() as { error: string }).error, "quota_daily_hours");
    // The track that is playing can still be re-requested (seeking, re-buffering).
    const again = await streamUrl(t, ids[1], t.userToken, "Same/1");
    assert.equal(again.statusCode, 200);
    // Other people have their own allowance.
    assert.equal((await streamUrl(t, ids[2], t.adminToken, "Admin/1")).statusCode, 200);
  });
});

test("with no limits set nothing is refused, but use is still counted", async () => {
  await withLibrary(async (t, ids) => {
    for (const id of ids) {
      const url = await streamUrl(t, id, t.userToken, `Device/${id}`);
      assert.equal(url.statusCode, 200);
      await t.app.inject({ method: "GET", url: `/${(url.json() as StreamUrlResponse).path.replace(/^\//, "")}`, headers: { "user-agent": `Device/${id}` } });
    }
    const usage = (await t.app.inject({ method: "GET", url: "/api/quotas/usage", headers: t.auth(t.adminToken) })).json() as { items: { username: string; streams30: number }[] };
    assert.equal(usage.items.find((u) => u.username === "listener")!.streams30, 3);
  });
});