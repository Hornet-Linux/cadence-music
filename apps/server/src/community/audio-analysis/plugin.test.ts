import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TrackListResponse } from "@uma/shared";
import { hasFfmpeg } from "../_serverlib/ffmpeg.js";
import { makeKit } from "../_serverlib/testkit.js";
import { makeWav } from "../_serverlib/wav.js";
import { analyzeFile } from "./plugin.js";
import plugin from "./plugin.js";

/** Kick on every beat plus a bass-y chord: enough for a tempo and a key. */
function song(bpm: number, seconds: number, chord: number[]) {
  const beat = 60 / bpm;
  return makeWav(
    seconds,
    (t) => {
      const since = t % beat;
      const kick = 0.8 * Math.exp(-since * 40) * Math.sin(2 * Math.PI * (60 + 80 * Math.exp(-since * 25)) * since);
      let pad = 0;
      for (const f of chord) for (let h = 1; h <= 3; h++) pad += Math.sin(2 * Math.PI * f * h * t) / h;
      return kick + (0.15 * pad) / chord.length;
    },
    22050,
  );
}

const C_MAJOR = [130.81, 164.81, 196];
const A_MINOR = [110, 130.81, 164.81];

test("ffmpeg decoding plus analysis gives tempo and key for a file", { skip: !hasFfmpeg() }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadence-aa-"));
  try {
    const file = path.join(dir, "song.wav");
    fs.writeFileSync(file, song(110, 40, C_MAJOR));
    const f = await analyzeFile(file, 40);
    assert.ok(f.bpm !== null && Math.abs(f.bpm - 110) <= 2, `bpm ${f.bpm}`);
    assert.equal(f.key, "C major");
    assert.ok(f.energy >= 0 && f.energy <= 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the job analyses the library; tracks carry bpm/key and can be searched and matched", { skip: !hasFfmpeg() }, async () => {
  const kit = await makeKit([plugin], {
    "a/slow.wav": song(80, 30, A_MINOR),
    "a/fast.wav": song(120, 30, C_MAJOR),
    "a/near.wav": song(122, 30, C_MAJOR),
    "a/broken.wav": Buffer.from("nope"),
  });
  try {
    await kit.app.inject({ method: "PUT", url: "/api/audio-analysis/settings", headers: kit.admin, payload: { pauseMs: 0, auto: false } });
    assert.equal((await kit.app.inject({ method: "POST", url: "/api/audio-analysis/start", headers: kit.admin })).statusCode, 202);
    for (let i = 0; i < 200; i++) {
      const s = (await kit.app.inject({ method: "GET", url: "/api/audio-analysis/status", headers: kit.member })).json();
      if (!s.run.running && s.run.finishedAt) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const status = (await kit.app.inject({ method: "GET", url: "/api/audio-analysis/status", headers: kit.member })).json();
    assert.equal(status.analysed, 3);
    assert.equal(status.failed, 1);
    type T = TrackListResponse["items"][number] & { bpm?: number; key?: string; camelot?: string };
    const items = ((await kit.app.inject({ method: "GET", url: "/api/tracks", headers: kit.member })).json() as TrackListResponse).items as T[];
    const slow = items.find((t) => t.title === "slow")!;
    const fast = items.find((t) => t.title === "fast")!;
    const near = items.find((t) => t.title === "near")!;
    assert.ok(Math.abs(slow.bpm! - 80) <= 2, `slow ${slow.bpm}`);
    assert.equal(slow.key, "A minor");
    assert.equal(fast.camelot, "8B");
    const range = (await kit.app.inject({ method: "GET", url: "/api/audio-analysis/tracks?bpmMin=100&bpmMax=130", headers: kit.member })).json();
    assert.deepEqual(range.items.map((t: { title: string }) => t.title).sort(), ["fast", "near"]);
    const match = (await kit.app.inject({ method: "GET", url: `/api/audio-analysis/compatible/${fast.id}`, headers: kit.member })).json();
    assert.deepEqual(match.items.map((t: { id: string }) => t.id), [near.id]);
  } finally {
    await kit.close();
  }
});

test("without ffmpeg the plugin reports it and refuses to start", { skip: hasFfmpeg() }, async () => {
  const kit = await makeKit([plugin], { "a/x.wav": makeWav(1, () => 0, 8000) });
  try {
    assert.equal((await kit.app.inject({ method: "POST", url: "/api/audio-analysis/start", headers: kit.admin })).statusCode, 409);
    assert.equal((await kit.app.inject({ method: "GET", url: "/api/audio-analysis/status", headers: kit.member })).json().ffmpeg, false);
    assert.equal((await kit.app.inject({ method: "GET", url: "/api/audio-analysis/nope", headers: kit.member })).statusCode, 404);
  } finally {
    await kit.close();
  }
});