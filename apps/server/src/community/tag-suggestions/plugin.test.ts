import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { TrackListResponse } from "@uma/shared";
import { makeKit } from "../_serverlib/testkit.js";
import { makeWav, sine } from "../_serverlib/wav.js";
import plugin from "./plugin.js";

const wav = (tags: Parameters<typeof makeWav>[3], seconds = 1) => makeWav(seconds, sine(300 + (tags?.track ?? 0) * 10), 8000, tags);

test("accepted suggestions are served by the library API as overlays; files stay untouched", async () => {
  const kit = await makeKit([plugin], {
    "Mix/Album/01 - first.wav": wav({}),
    "Band/Rec/shout.wav": wav({ title: "LOUD SONG ft. FRIEND", artist: "Band", album: "Rec", track: 2 }),
  });
  try {
    const original = fs.readFileSync(path.join(kit.musicDir, "Band/Rec/shout.wav"));
    const before = (await kit.app.inject({ method: "GET", url: "/api/tracks", headers: kit.member })).json() as TrackListResponse;
    const shout = before.items.find((x) => x.title.startsWith("LOUD"))!;
    assert.ok(shout, "tags are read from the file");

    // Not an admin: no access.
    assert.equal((await kit.app.inject({ method: "GET", url: "/api/tag-suggestions", headers: kit.member })).statusCode, 403);

    const scan = (await kit.app.inject({ method: "POST", url: "/api/tag-suggestions/scan", headers: kit.admin })).json();
    assert.ok(scan.pending >= 3);
    const list = (await kit.app.inject({ method: "GET", url: "/api/tag-suggestions", headers: kit.admin })).json();
    const titleFix = list.items.find((s: { trackId: string; field: string }) => s.trackId === shout.id && s.field === "title");
    assert.equal(titleFix.newValue, "Loud Song feat. Friend");
    assert.equal(titleFix.oldValue, "LOUD SONG ft. FRIEND");
    assert.match(titleFix.rule, /feat/);
    assert.match(titleFix.rule, /casing/);

    // Nothing changes until an admin accepts.
    const same = (await kit.app.inject({ method: "GET", url: `/api/tracks/${shout.id}`, headers: kit.member })).json();
    assert.equal(same.title, "LOUD SONG ft. FRIEND");

    const accept = await kit.app.inject({ method: "POST", url: `/api/tag-suggestions/${titleFix.id}/accept`, headers: kit.admin, payload: {} });
    assert.equal(accept.statusCode, 200);
    const after = (await kit.app.inject({ method: "GET", url: `/api/tracks/${shout.id}`, headers: kit.member })).json();
    assert.equal(after.title, "Loud Song feat. Friend");
    assert.deepEqual(after.tagOverrides, ["title"]);
    const listed = ((await kit.app.inject({ method: "GET", url: "/api/tracks", headers: kit.member })).json() as TrackListResponse).items;
    assert.equal(listed.find((x) => x.id === shout.id)!.title, "Loud Song feat. Friend", "the list is overlaid too");

    // The first track: no tags at all, so the file name gives a title and a track number.
    const firstId = before.items.find((x) => x.title.startsWith("01"))!.id;
    const bulk = await kit.app.inject({ method: "POST", url: "/api/tag-suggestions/accept", headers: kit.admin, payload: { rule: "track-number" } });
    assert.equal(bulk.json().accepted, 1);
    assert.equal((await kit.app.inject({ method: "GET", url: `/api/tracks/${firstId}`, headers: kit.member })).json().trackNo, 1);

    // Regenerating does not propose the same fixes again, and decisions are remembered.
    const again = (await kit.app.inject({ method: "POST", url: "/api/tag-suggestions/scan", headers: kit.admin })).json();
    const pending = (await kit.app.inject({ method: "GET", url: "/api/tag-suggestions", headers: kit.admin })).json();
    assert.ok(!pending.items.some((s: { id: number }) => s.id === titleFix.id));
    assert.ok(again.pending < scan.pending);

    // Reject something, and it stays rejected after a rescan of suggestions.
    const firstTitle = pending.items.find((s: { trackId: string; field: string }) => s.trackId === firstId && s.field === "title");
    assert.ok(firstTitle, "the file name title is proposed");
    await kit.app.inject({ method: "POST", url: `/api/tag-suggestions/${firstTitle.id}/reject`, headers: kit.admin });
    await kit.app.inject({ method: "POST", url: "/api/tag-suggestions/scan", headers: kit.admin });
    const rejected = (await kit.app.inject({ method: "GET", url: "/api/tag-suggestions?status=rejected", headers: kit.admin })).json();
    assert.equal(rejected.total, 1);
    const still = (await kit.app.inject({ method: "GET", url: "/api/tag-suggestions", headers: kit.admin })).json();
    assert.ok(!still.items.some((s: { trackId: string; field: string }) => s.trackId === firstId && s.field === "title"));

    // Revert brings the file tag back.
    assert.equal((await kit.app.inject({ method: "POST", url: `/api/tag-suggestions/${titleFix.id}/revert`, headers: kit.admin })).statusCode, 200);
    const reverted = (await kit.app.inject({ method: "GET", url: `/api/tracks/${shout.id}`, headers: kit.member })).json();
    assert.equal(reverted.title, "LOUD SONG ft. FRIEND");
    assert.equal(reverted.tagOverrides, undefined);

    assert.equal(fs.readFileSync(path.join(kit.musicDir, "Band/Rec/shout.wav")).equals(original), true, "the audio file is unchanged");
  } finally {
    await kit.close();
  }
});

test("an edited value is validated and stored instead of the suggestion", async () => {
  const kit = await makeKit([plugin], { "A/B/02 - song.wav": wav({}) });
  try {
    await kit.app.inject({ method: "POST", url: "/api/tag-suggestions/scan", headers: kit.admin });
    const list = (await kit.app.inject({ method: "GET", url: "/api/tag-suggestions", headers: kit.admin })).json();
    const track = list.items.find((s: { field: string }) => s.field === "trackNo");
    const bad = await kit.app.inject({ method: "POST", url: `/api/tag-suggestions/${track.id}/accept`, headers: kit.admin, payload: { value: "abc" } });
    assert.equal(bad.statusCode, 400);
    const ok = await kit.app.inject({ method: "POST", url: `/api/tag-suggestions/${track.id}/accept`, headers: kit.admin, payload: { value: "12" } });
    assert.equal(ok.statusCode, 200);
    const tracks = (await kit.app.inject({ method: "GET", url: "/api/tracks", headers: kit.member })).json() as TrackListResponse;
    assert.equal(tracks.items[0]!.trackNo, 12);
    assert.equal((await kit.app.inject({ method: "POST", url: "/api/tag-suggestions/accept", headers: kit.admin, payload: {} })).statusCode, 400);
  } finally {
    await kit.close();
  }
});