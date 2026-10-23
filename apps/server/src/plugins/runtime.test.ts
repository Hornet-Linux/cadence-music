import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Jobs, ServerEvents } from "./runtime.js";
import { loadCommunityPlugins } from "./community.js";

const log = { warn() {}, error() {}, info() {} } as never;

test("events reach listeners, and a throwing listener does not stop the others", () => {
  const events = new ServerEvents(log);
  const seen: string[] = [];
  events.on("play.recorded", () => {
    throw new Error("boom");
  });
  events.on("play.recorded", (p) => void seen.push(p.track.title));
  events.emit("play.recorded", { userId: 1, track: { id: "a", title: "Song", artists: [] }, playedAt: 1 });
  assert.deepEqual(seen, ["Song"]);
});

test("a listener can be removed", () => {
  const events = new ServerEvents(log);
  let calls = 0;
  const off = events.on("play.recorded", () => void calls++);
  off();
  events.emit("play.recorded", { userId: 1, track: { id: "a", title: "S", artists: [] }, playedAt: 1 });
  assert.equal(calls, 0);
});

test("jobs run soon when asked, never overlap, and stop on request", async () => {
  const jobs = new Jobs(log);
  let runs = 0;
  jobs.every("t", 60_000, async () => {
    runs++;
  }, { runSoon: true });
  await new Promise((r) => setTimeout(r, 2300));
  assert.equal(runs, 1);
  jobs.stop();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(runs, 1);
});

test("community plugins are found in folders and a broken one is skipped", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "community-"));
  fs.mkdirSync(path.join(dir, "good"));
  fs.writeFileSync(
    path.join(dir, "good", "plugin.js"),
    'export default { id: "x.good", name: "Good", version: "1.0.0", register() {} };',
  );
  fs.mkdirSync(path.join(dir, "bad"));
  fs.writeFileSync(path.join(dir, "bad", "plugin.js"), "throw new Error('nope');");
  fs.mkdirSync(path.join(dir, "empty"));
  const found = await loadCommunityPlugins(log, dir);
  assert.deepEqual(found.map((p) => p.id), ["x.good"]);
  assert.deepEqual(await loadCommunityPlugins(log, path.join(dir, "missing")), []);
});
