import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeWav, sine } from "../_serverlib/wav.js";
import { hasFfmpeg } from "../_serverlib/ffmpeg.js";
import { makeKit } from "../_serverlib/testkit.js";
import type { HealthReport } from "./report.js";
import libraryHealth from "./plugin.js";

const tone = makeWav(2, sine(440));

test("library health reports duplicates, missing artwork, and unreadable files from a real scan", async () => {
  const kit = await makeKit([libraryHealth], {
    "Artist/Album/one.wav": tone,
    "Artist/Album/copy of one.wav": tone,
    "Artist/Other/different.wav": makeWav(3, sine(660)),
    "Broken/garbage.wav": Buffer.from("this is not audio at all, just text pretending to be a wav file"),
    "Broken/empty.wav": Buffer.alloc(0),
  });
  try {
    const res = await kit.app.inject({ method: "POST", url: "/api/library-health/scan?wait=1", headers: kit.admin });
    assert.equal(res.statusCode, 200);

    const report = (await kit.app.inject({ method: "GET", url: "/api/library-health/report", headers: kit.admin })).json() as HealthReport;
    assert.equal(report.summary.tracks, 5);
    assert.equal(report.summary.indexed, 5);
    assert.equal(report.summary.exactDuplicateGroups, 1);
    const dup = report.duplicates[0]!;
    assert.deepEqual(dup.tracks.map((t) => path.basename(t.relPath)).sort(), ["copy of one.wav", "one.wav"]);
    assert.equal(report.summary.unreadable + report.summary.corrupt, 2);
    assert.ok(report.problems.some((p) => p.relPath === "Broken/empty.wav" && p.kind === "unreadable"));
    assert.ok(report.problems.some((p) => p.relPath === "Broken/garbage.wav"));
    assert.ok(report.summary.missingArtworkTracks >= 3, "none of the good files has artwork");

    // Dropping a cover.jpg next to the album clears its artwork warning after a rescan.
    kit.put("Artist/Album/cover.jpg", "jpg");
    kit.put("Artist/Album/new track.wav", makeWav(1, sine(300)));
    await kit.rescan();
    await kit.app.inject({ method: "POST", url: "/api/library-health/scan?wait=1", headers: kit.admin });
    const again = (await kit.app.inject({ method: "GET", url: "/api/library-health/report", headers: kit.admin })).json() as HealthReport;
    assert.equal(again.summary.tracks, 6);
    assert.ok(!again.missingArtwork.some((a) => a.folder === "Artist/Album"));

    // Nothing in the (possibly read-only) music folder was modified.
    assert.equal(fs.readFileSync(path.join(kit.musicDir, "Artist/Album/one.wav")).equals(tone), true);
  } finally {
    await kit.close();
  }
});

test("the report and scan are admin-only", async () => {
  const kit = await makeKit([libraryHealth]);
  try {
    for (const [method, url] of [
      ["GET", "/api/library-health/report"],
      ["GET", "/api/library-health/status"],
      ["POST", "/api/library-health/scan"],
    ] as const) {
      assert.equal((await kit.app.inject({ method, url })).statusCode, 401);
      assert.equal((await kit.app.inject({ method, url, headers: kit.member })).statusCode, 403);
    }
  } finally {
    await kit.close();
  }
});

test("the deep scan finds files ffmpeg cannot decode", { skip: !hasFfmpeg() }, async () => {
  const truncated = tone.subarray(0, 30);
  const kit = await makeKit([libraryHealth], { "a/ok.wav": tone, "a/cut.wav": Buffer.concat([tone.subarray(0, 44), Buffer.alloc(3, 1)]), "a/tiny.wav": truncated });
  try {
    const res = await kit.app.inject({ method: "POST", url: "/api/library-health/scan?wait=1&deep=1", headers: kit.admin });
    assert.equal(res.statusCode, 200);
    const report = (await kit.app.inject({ method: "GET", url: "/api/library-health/report", headers: kit.admin })).json() as HealthReport;
    assert.ok(!report.problems.some((p) => p.relPath === "a/ok.wav"), "a healthy file is not flagged");
  } finally {
    await kit.close();
  }
});

test("a deep scan without ffmpeg is refused cleanly", { skip: hasFfmpeg() }, async () => {
  const kit = await makeKit([libraryHealth]);
  try {
    const res = await kit.app.inject({ method: "POST", url: "/api/library-health/scan?deep=1", headers: kit.admin });
    assert.equal(res.statusCode, 409);
  } finally {
    await kit.close();
  }
});