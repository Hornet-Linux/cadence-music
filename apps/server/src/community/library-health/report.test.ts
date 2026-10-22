import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, findDuplicateGroups, normalizeText, type HealthTrack } from "./report.js";

const track = (id: string, over: Partial<HealthTrack> = {}): HealthTrack => ({
  id,
  relPath: `Artist/Album/${id}.mp3`,
  title: id,
  artist: "Artist",
  album: "Album",
  albumArtist: "Artist",
  trackNo: 1,
  size: 4_000_000,
  durationSec: 200,
  genre: "Rock",
  year: 2000,
  hasArtwork: true,
  hasTitleTag: true,
  indexed: true,
  error: null,
  decodeError: null,
  bitrate: 192,
  codec: "MPEG 1 Layer 3",
  lossless: false,
  ...over,
});

test("normalizeText ignores case, accents, punctuation, feat. credits and a leading The", () => {
  assert.equal(normalizeText("The Beyoncé Song!"), "beyonce song");
  assert.equal(normalizeText("Song (feat. Someone)"), "song");
  assert.equal(normalizeText("Song ft. Someone Else"), "song");
  assert.equal(normalizeText(null), "");
});

test("finds duplicates by title/artist/length and by identical size and length", () => {
  const groups = findDuplicateGroups([
    track("a", { title: "Hello", size: 1_000_000, durationSec: 100 }),
    track("b", { title: "hello", relPath: "Other/b.mp3", size: 2_000_000, durationSec: 101, bitrate: 320 }),
    track("c", { title: "Different", size: 3_000_000, durationSec: 100 }),
    // Same audio under different tags: the sampled file contents match.
    track("d", { title: "Mystery", artist: "X", size: 5_555_555, durationSec: 240, contentHash: "same" }),
    track("e", { title: "Unknown track 7", artist: null, size: 5_555_555, durationSec: 240.04, contentHash: "same" }),
    // Same size and length (as uncompressed files of equal length always are) but different contents.
    track("g", { title: "Echoes", artist: "O", album: "Mix", size: 3_000_000, durationSec: 16, contentHash: "one" }),
    track("h", { title: "Tides", artist: "H", album: "Mix", size: 3_000_000, durationSec: 16, contentHash: "two" }),
    // Same size and length, contents not sampled: only linked when the tags agree.
    track("i", { title: "Same Name", artist: "A", album: "X", size: 2_000_000, durationSec: 50, relPath: "a/i.mp3" }),
    track("j", { title: "Same Name", artist: "B", album: "Y", size: 2_000_000, durationSec: 80, relPath: "b/j.mp3" }),
    track("k", { title: "Other", artist: "C", album: "Z", size: 4_100_000, durationSec: 70 }),
    track("l", { title: "Different", artist: "D", album: "W", size: 4_100_000, durationSec: 70 }),
    // Same title but a very different length is a different recording.
    track("f", { title: "Hello", durationSec: 300, size: 7_000_000 }),
  ]);
  assert.equal(groups.length, 2, "echoes/tides and k/l are not duplicates; i/j differ in length");
  const exact = groups.find((g) => g.confidence === "exact")!;
  assert.deepEqual(exact.tracks.map((t) => t.id).sort(), ["d", "e"]);
  assert.deepEqual(exact.reasons, ["identical audio data"]);
  const likely = groups.find((g) => g.confidence === "likely")!;
  assert.deepEqual(likely.tracks.map((t) => t.id).sort(), ["a", "b"]);
  assert.equal(likely.suggestedKeepId, "b", "the higher bitrate copy is the one to keep");
  assert.equal(groups[0]!.confidence, "exact", "exact groups come first");
});

test("unknown lengths only match on identical size", () => {
  const groups = findDuplicateGroups([
    track("a", { title: "Same", durationSec: null, size: 100_000 }),
    track("b", { title: "Same", durationSec: null, size: 100_001 }),
  ]);
  assert.equal(groups.length, 0);
});

test("the report counts missing tags, artwork by album, and problem files", () => {
  const report = buildReport([
    track("ok"),
    track("noart1", { hasArtwork: false, relPath: "A/Alb/1.mp3", title: "t1", size: 1_111_111 }),
    track("noart2", { hasArtwork: false, relPath: "A/Alb/2.mp3", title: "t2", size: 2_222_222 }),
    track("notags", { artist: null, album: null, hasTitleTag: false, genre: null, size: 3_333_333, title: "notags" }),
    track("broken", { error: "unreadable tags: bad header", size: 4_444_444, title: "broken" }),
    track("short", { error: "no playable duration (file may be truncated or corrupt)", size: 5_555_555, title: "short" }),
    track("decode", { decodeError: "invalid data found", size: 6_666_666, title: "decode" }),
    track("pending", {
      indexed: false,
      hasArtwork: null,
      hasTitleTag: null,
      genre: null,
      year: null,
      size: 7_777_777,
      title: "pending",
    }),
  ]);
  assert.equal(report.summary.tracks, 8);
  assert.equal(report.summary.indexed, 7);
  assert.equal(report.summary.missingArtworkTracks, 2);
  assert.equal(report.summary.missingArtworkAlbums, 1, "tracks of one album are one entry");
  assert.equal(report.missingArtwork[0]!.tracks, 2);
  assert.equal(report.summary.unreadable, 1);
  assert.equal(report.summary.corrupt, 2);
  assert.deepEqual(report.problems.map((p) => p.kind).sort(), ["corrupt", "corrupt", "unreadable"]);
  assert.equal(report.summary.tracksMissingTags, 1);
  assert.deepEqual(report.missingTags[0]!.missing.slice(0, 3), ["title", "artist", "album"]);
  assert.equal(report.summary.missingTagCounts.genre, 1, "genre is only counted for indexed files");
});

test("the report respects its list limit", () => {
  const many = Array.from({ length: 30 }, (_, i) => track(`n${i}`, { artist: null, size: 1_000_000 + i, title: `n${i}` }));
  const report = buildReport(many, 5);
  assert.equal(report.missingTags.length, 5);
  assert.equal(report.summary.tracksMissingTags, 30);
});
