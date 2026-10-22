import { test } from "node:test";
import assert from "node:assert/strict";
import type { TrackListResponse } from "@uma/shared";
import { hasFfmpeg } from "../_serverlib/ffmpeg.js";
import { makeKit } from "../_serverlib/testkit.js";
import { makeWav, sine } from "../_serverlib/wav.js";
import { analyzeLoudness, parseEbur128, replayGainDb } from "./analyze.js";
import plugin from "./plugin.js";

const SAMPLE = `
[Parsed_ebur128_0 @ 0x55d] t: 0.1  M: -70.0 S: -120.7 I: -70.0 LUFS LRA: 0.0 LU FTPK: -6.0 dBFS TPK: -6.0 dBFS
[Parsed_ebur128_0 @ 0x55d] Summary:

  Integrated loudness:
    I:         -14.2 LUFS
    Threshold: -24.2 LUFS

  Loudness range:
    LRA:         5.3 LU
    LRA threshold: -34.2 LUFS
    LRA low:   -18.0 LUFS
    LRA high:  -12.7 LUFS

  True peak:
    Peak:       -0.4 dBFS
`;

test("parses the ebur128 summary and ignores progress lines", () => {
  assert.deepEqual(parseEbur128(SAMPLE), { lufs: -14.2, lra: 5.3, truePeakDb: -0.4 });
  assert.equal(parseEbur128("no summary here"), null);
});

test("silence has no loudness and gets no gain", () => {
  const silent = parseEbur128("Summary:\n  Integrated loudness:\n    I:         -inf LUFS\n  Loudness range:\n    LRA:         0.0 LU\n  True peak:\n    Peak:       -inf dBFS\n");
  assert.deepEqual(silent, { lufs: null, lra: 0, truePeakDb: null });
  assert.equal(replayGainDb({ lufs: null, truePeakDb: null }), null);
});

test("gain targets -18 LUFS and never pushes peaks past -1 dBFS", () => {
  assert.equal(replayGainDb({ lufs: -23, truePeakDb: -10 }), 5);
  assert.equal(replayGainDb({ lufs: -9, truePeakDb: -0.5 }), -9);
  assert.equal(replayGainDb({ lufs: -23, truePeakDb: -2 }), 1, "limited by the peak, not the target");
  assert.equal(replayGainDb({ lufs: -18, truePeakDb: null }), 0);
});

test("ffmpeg measures a quiet and a loud tone", { skip: !hasFfmpeg() }, async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadence-loud-"));
  try {
    const loud = path.join(dir, "loud.wav");
    const quiet = path.join(dir, "quiet.wav");
    fs.writeFileSync(loud, makeWav(4, sine(1000, 0.5), 44100));
    fs.writeFileSync(quiet, makeWav(4, sine(1000, 0.25), 44100));
    const a = await analyzeLoudness(loud);
    const b = await analyzeLoudness(quiet);
    assert.ok(a.lufs !== null && b.lufs !== null);
    assert.ok(Math.abs(a.lufs - -9.1) < 1.5, `loud tone: ${a.lufs}`);
    assert.ok(Math.abs(a.lufs - b.lufs - 6.02) < 0.5, "half the amplitude is 6 dB quieter");
    assert.ok(a.truePeakDb !== null && Math.abs(a.truePeakDb - -6.02) < 0.5, `peak: ${a.truePeakDb}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the job analyses tracks, resumes, and the track API carries the result", { skip: !hasFfmpeg() }, async () => {
  const kit = await makeKit([plugin], {
    "a/one.wav": makeWav(2, sine(1000, 0.5), 22050),
    "a/two.wav": makeWav(2, sine(500, 0.1), 22050),
    "a/broken.wav": Buffer.from("not audio"),
  });
  try {
    await kit.app.inject({ method: "PUT", url: "/api/loudness/settings", headers: kit.admin, payload: { pauseMs: 0, auto: false } });
    assert.equal((await kit.app.inject({ method: "POST", url: "/api/loudness/start", headers: kit.member })).statusCode, 403);
    assert.equal((await kit.app.inject({ method: "POST", url: "/api/loudness/start", headers: kit.admin })).statusCode, 202);
    for (let i = 0; i < 100; i++) {
      const s = (await kit.app.inject({ method: "GET", url: "/api/loudness/status", headers: kit.member })).json();
      if (!s.run.running && s.run.finishedAt) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const status = (await kit.app.inject({ method: "GET", url: "/api/loudness/status", headers: kit.member })).json();
    assert.equal(status.analysed, 2);
    assert.equal(status.failed, 1, "an unreadable file is recorded once, not retried forever");
    assert.equal(status.pending, 0);
    const tracks = ((await kit.app.inject({ method: "GET", url: "/api/tracks", headers: kit.member })).json() as TrackListResponse).items as (TrackListResponse["items"][number] & { replayGainDb?: number; loudnessLufs?: number })[];
    const one = tracks.find((t) => t.title === "one")!;
    const two = tracks.find((t) => t.title === "two")!;
    assert.ok(typeof one.loudnessLufs === "number" && typeof one.replayGainDb === "number");
    assert.ok(two.replayGainDb! > one.replayGainDb!, "the quieter track needs more gain");
    const single = (await kit.app.inject({ method: "GET", url: `/api/loudness/${one.id}`, headers: kit.member })).json();
    assert.equal(single.loudnessLufs, one.loudnessLufs);
    const bulk = (await kit.app.inject({ method: "GET", url: `/api/loudness?ids=${one.id},${two.id}`, headers: kit.member })).json();
    assert.deepEqual(Object.keys(bulk.items).sort(), [one.id, two.id].sort());
  } finally {
    await kit.close();
  }
});

test("without ffmpeg the plugin says so instead of failing", { skip: hasFfmpeg() }, async () => {
  const kit = await makeKit([plugin], { "a/one.wav": makeWav(1, sine(440), 8000) });
  try {
    const res = await kit.app.inject({ method: "POST", url: "/api/loudness/start", headers: kit.admin });
    assert.equal(res.statusCode, 409);
    const status = (await kit.app.inject({ method: "GET", url: "/api/loudness/status", headers: kit.member })).json();
    assert.equal(status.ffmpeg, false);
    assert.equal(status.pending, 1);
  } finally {
    await kit.close();
  }
});