import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hasFfmpeg } from "../_serverlib/ffmpeg.js";
import { makeKit, type Kit } from "../_serverlib/testkit.js";
import { makeWav, sine } from "../_serverlib/wav.js";
import plugin from "./plugin.js";

const WAV = makeWav(6, sine(440, 0.4), 44100);

async function streamPath(kit: Kit, id: string, query = ""): Promise<string> {
  const res = await kit.app.inject({ method: "GET", url: `/api/tracks/${id}/stream-url${query}`, headers: kit.member });
  return "/" + (res.json() as { path: string }).path;
}

async function trackId(kit: Kit): Promise<string> {
  const list = (await kit.app.inject({ method: "GET", url: "/api/tracks", headers: kit.member })).json();
  return list.items[0].id as string;
}

test("transcodes to Opus with exact Range support and serves repeats from the cache", { skip: !hasFfmpeg() }, async () => {
  const kit = await makeKit([plugin], { "a/tone.wav": WAV });
  try {
    const id = await trackId(kit);
    const url = (await streamPath(kit, id)) + "&profile=opus-96";

    const first = await kit.app.inject({ method: "GET", url });
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers["content-type"], "audio/ogg");
    assert.equal(first.headers["x-transcode-profile"], "opus-96");
    assert.equal(first.headers["x-transcode-cache"], "miss");
    assert.equal(first.rawPayload.subarray(0, 4).toString(), "OggS");
    assert.ok(first.rawPayload.length < WAV.length / 5, "much smaller than the WAV");
    assert.equal(Number(first.headers["content-length"]), first.rawPayload.length);

    const second = await kit.app.inject({ method: "GET", url });
    assert.equal(second.headers["x-transcode-cache"], "hit");
    assert.ok(second.rawPayload.equals(first.rawPayload));

    const range = await kit.app.inject({ method: "GET", url, headers: { range: "bytes=100-199" } });
    assert.equal(range.statusCode, 206);
    assert.equal(range.headers["content-range"], `bytes 100-199/${first.rawPayload.length}`);
    assert.ok(range.rawPayload.equals(first.rawPayload.subarray(100, 200)));
    const tail = await kit.app.inject({ method: "GET", url, headers: { range: "bytes=-50" } });
    assert.equal(tail.statusCode, 206);
    assert.ok(tail.rawPayload.equals(first.rawPayload.subarray(first.rawPayload.length - 50)));
    assert.equal((await kit.app.inject({ method: "GET", url, headers: { range: "bytes=99999999-" } })).statusCode, 416);

    const status = (await kit.app.inject({ method: "GET", url: "/api/transcode/status", headers: kit.member })).json();
    assert.equal(status.ffmpeg.available, true);
    assert.equal(status.cache.files, 1);
    assert.ok(status.profiles.find((p: { id: string }) => p.id === "opus-96").available);
    assert.ok(fs.readdirSync(path.join(kit.dataDir, "transcode-cache")).some((f) => f.endsWith(".opus")));
  } finally {
    await kit.close();
  }
});

test("every profile produces playable output in its container", { skip: !hasFfmpeg() }, async () => {
  const kit = await makeKit([plugin], { "a/tone.wav": WAV });
  try {
    const id = await trackId(kit);
    const base = await streamPath(kit, id);
    for (const [profile, mime, magic] of [
      ["opus-128", "audio/ogg", "OggS"],
      ["aac-128", "audio/aac", ""],
      ["mp3-128", "audio/mpeg", ""],
    ] as const) {
      const res = await kit.app.inject({ method: "GET", url: `${base}&profile=${profile}` });
      assert.equal(res.statusCode, 200, profile);
      assert.equal(res.headers["content-type"], mime);
      assert.ok(res.rawPayload.length > 1000, profile);
      if (magic) assert.equal(res.rawPayload.subarray(0, 4).toString(), magic);
      if (profile === "aac-128") assert.equal(res.rawPayload[0], 0xff, "ADTS sync word");
      if (profile === "mp3-128") assert.ok(res.rawPayload[0] === 0xff || res.rawPayload.subarray(0, 3).toString() === "ID3");
    }
  } finally {
    await kit.close();
  }
});

test("long songs start playing while they are converted, and the finished file matches", { skip: !hasFfmpeg() }, async () => {
  const kit = await makeKit([plugin], { "a/tone.wav": WAV });
  try {
    await kit.app.inject({
      method: "PUT",
      url: "/api/transcode/settings",
      headers: kit.admin,
      payload: { liveStartAfterSec: 1 },
    });
    const id = await trackId(kit);
    const url = (await streamPath(kit, id)) + "&profile=opus-96";
    const live = await kit.app.inject({ method: "GET", url });
    assert.equal(live.statusCode, 200);
    assert.equal(live.headers["x-transcode-cache"], "live");
    assert.equal(live.headers["accept-ranges"], "none");
    assert.equal(live.headers["content-length"], undefined);
    assert.equal(live.rawPayload.subarray(0, 4).toString(), "OggS");
    const cached = await kit.app.inject({ method: "GET", url });
    assert.equal(cached.headers["x-transcode-cache"], "hit");
    assert.ok(cached.rawPayload.equals(live.rawPayload), "the live stream carried the same bytes as the cached file");
  } finally {
    await kit.close();
  }
});

test("a time offset streams from that point without caching", { skip: !hasFfmpeg() }, async () => {
  const kit = await makeKit([plugin], { "a/tone.wav": WAV });
  try {
    const id = await trackId(kit);
    const url = (await streamPath(kit, id)) + "&profile=mp3-128";
    const whole = await kit.app.inject({ method: "GET", url });
    const half = await kit.app.inject({ method: "GET", url: url + "&start=3" });
    assert.equal(half.statusCode, 200);
    assert.equal(half.headers["accept-ranges"], "none");
    assert.ok(
      half.rawPayload.length > 1000 && half.rawPayload.length < whole.rawPayload.length * 0.75,
      `${half.rawPayload.length} vs ${whole.rawPayload.length}`,
    );
  } finally {
    await kit.close();
  }
});

test("stream URLs follow the device preference, and an explicit profile wins", async () => {
  const kit = await makeKit([plugin], { "a/tone.wav": makeWav(1, sine(440), 8000) });
  try {
    const id = await trackId(kit);
    assert.ok(!(await streamPath(kit, id)).includes("profile="), "no preference: original");

    const set = await kit.app.inject({
      method: "PUT",
      url: "/api/transcode/preference",
      headers: kit.member,
      payload: { profile: "opus-96" },
    });
    assert.equal(set.statusCode, 200);
    assert.match(await streamPath(kit, id), /&profile=opus-96$/);
    assert.match(await streamPath(kit, id, "?profile=mp3-192"), /&profile=mp3-192$/);
    assert.ok(!(await streamPath(kit, id, "?profile=original")).includes("profile="));
    // Another device (the admin's session) is not affected.
    const other = await kit.app.inject({ method: "GET", url: `/api/tracks/${id}/stream-url`, headers: kit.admin });
    assert.ok(!other.json().path.includes("profile="));

    assert.equal(
      (
        await kit.app.inject({
          method: "PUT",
          url: "/api/transcode/preference",
          headers: kit.member,
          payload: { profile: "bogus" },
        })
      ).statusCode,
      400,
    );
    await kit.app.inject({ method: "PUT", url: "/api/transcode/preference", headers: kit.member, payload: { profile: null } });
    assert.ok(!(await streamPath(kit, id)).includes("profile="));
    // "original" is a choice of its own: it wins over a server default.
    await kit.app.inject({
      method: "PUT",
      url: "/api/transcode/preference",
      headers: kit.member,
      payload: { profile: "original" },
    });

    // The admin can set a default for every device.
    assert.equal(
      (
        await kit.app.inject({
          method: "PUT",
          url: "/api/transcode/settings",
          headers: kit.member,
          payload: { defaultProfile: "aac-128" },
        })
      ).statusCode,
      403,
    );
    await kit.app.inject({
      method: "PUT",
      url: "/api/transcode/settings",
      headers: kit.admin,
      payload: { defaultProfile: "aac-128", maxCacheMb: 100 },
    });
    assert.ok(!(await streamPath(kit, id)).includes("profile="), "this device chose original");
    await kit.app.inject({ method: "PUT", url: "/api/transcode/preference", headers: kit.member, payload: { profile: null } });
    assert.match(await streamPath(kit, id), /&profile=aac-128$/);
  } finally {
    await kit.close();
  }
});

test("bad signatures and unknown profiles are refused; the library route is unchanged without a profile", async () => {
  const kit = await makeKit([plugin], { "a/tone.wav": WAV });
  try {
    const id = await trackId(kit);
    const url = await streamPath(kit, id);
    assert.equal(
      (await kit.app.inject({ method: "GET", url: url.replace(/sig=[^&]+/, "sig=nope") + "&profile=opus-96" })).statusCode,
      403,
    );
    assert.equal((await kit.app.inject({ method: "GET", url: url + "&profile=warp-9" })).statusCode, 400);
    const plain = await kit.app.inject({ method: "GET", url });
    assert.equal(plain.statusCode, 200);
    assert.equal(plain.headers["content-type"], "audio/wav");
    assert.ok(plain.rawPayload.equals(WAV));
  } finally {
    await kit.close();
  }
});

test("without ffmpeg the original file is streamed", async () => {
  const saved = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = path.join("definitely", "not", "ffmpeg");
  const kit = await makeKit([plugin], { "a/tone.wav": WAV });
  try {
    const id = await trackId(kit);
    const res = await kit.app.inject({ method: "GET", url: (await streamPath(kit, id)) + "&profile=opus-96" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["x-transcode-fallback"], "ffmpeg-missing");
    assert.equal(res.headers["content-type"], "audio/wav");
    assert.ok(res.rawPayload.equals(WAV), "the untouched original");
    const status = (await kit.app.inject({ method: "GET", url: "/api/transcode/status", headers: kit.member })).json();
    assert.equal(status.ffmpeg.available, false);
    assert.ok(status.profiles.every((p: { available: boolean }) => !p.available));
  } finally {
    if (saved === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = saved;
    await kit.close();
  }
});

test("clearing the cache is admin-only and empties it", { skip: !hasFfmpeg() }, async () => {
  const kit = await makeKit([plugin], { "a/tone.wav": WAV });
  try {
    const id = await trackId(kit);
    await kit.app.inject({ method: "GET", url: (await streamPath(kit, id)) + "&profile=opus-64" });
    assert.equal((await kit.app.inject({ method: "DELETE", url: "/api/transcode/cache", headers: kit.member })).statusCode, 403);
    const res = (await kit.app.inject({ method: "DELETE", url: "/api/transcode/cache", headers: kit.admin })).json();
    assert.equal(res.removed, 1);
    assert.equal(
      (await kit.app.inject({ method: "GET", url: "/api/transcode/status", headers: kit.member })).json().cache.files,
      0,
    );
  } finally {
    await kit.close();
  }
});
