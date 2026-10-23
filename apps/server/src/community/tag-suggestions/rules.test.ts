import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanText,
  fixCasing,
  normalizeFeat,
  parseFilenamePrefix,
  folderTags,
  suggestForLibrary,
  titleCase,
  type TagTrack,
} from "./rules.js";

const t = (id: string, over: Partial<TagTrack> = {}): TagTrack => ({
  id,
  relPath: `Artist/Album/${id}.mp3`,
  title: id,
  artist: "Artist",
  album: "Album",
  albumArtist: "Artist",
  trackNo: 1,
  ...over,
});

test("title case keeps small words lower and acronyms alone", () => {
  assert.equal(titleCase("THE LORD OF THE RINGS"), "The Lord of the Rings");
  assert.equal(titleCase("don't stop me now"), "Don't Stop Me Now");
  assert.equal(titleCase("rocky II: the return"), "Rocky II: The Return");
  assert.equal(titleCase("love (feat. someone)"), "Love (feat. Someone)");
});

test("casing only fixes shouting and all-lowercase titles", () => {
  assert.equal(fixCasing("HELLO WORLD", "title"), "Hello World");
  assert.equal(fixCasing("hello world", "title"), "Hello World");
  assert.equal(fixCasing("hello world", "artist"), null, "lower-case artist names are often a style choice");
  assert.equal(fixCasing("ABBA", "artist"), null, "short single words are acronyms");
  assert.equal(fixCasing("deadmau5", "artist"), null);
  assert.equal(fixCasing("Already Fine", "title"), null);
  assert.equal(fixCasing("hello", "title"), null, "a single lower-case word is left alone");
});

test("feat. wording is normalised", () => {
  assert.equal(normalizeFeat("Song ft. Someone"), "Song feat. Someone");
  assert.equal(normalizeFeat("Song (Feat Someone)"), "Song (feat. Someone)");
  assert.equal(normalizeFeat("Song featuring X"), "Song feat. X");
  assert.equal(normalizeFeat("Left Alone"), "Left Alone");
  assert.equal(normalizeFeat("Song feat. X"), "Song feat. X");
});

test("cleanText reports which rules fired, in order", () => {
  assert.deepEqual(cleanText("SOME  SONG ft. BOB", "title"), {
    value: "Some Song feat. Bob",
    rules: ["spacing", "feat", "casing"],
  });
  assert.deepEqual(cleanText("Fine Song", "title"), { value: "Fine Song", rules: [] });
});

test("file name prefixes give track numbers", () => {
  assert.deepEqual(parseFilenamePrefix("01 - Hello"), { trackNo: 1, rest: "Hello" });
  assert.deepEqual(parseFilenamePrefix("7. Seven"), { trackNo: 7, rest: "Seven" });
  assert.deepEqual(parseFilenamePrefix("1-05 Disc Track"), { trackNo: 5, rest: "Disc Track" });
  assert.deepEqual(parseFilenamePrefix("07 Song"), { trackNo: 7, rest: "Song" });
  assert.equal(parseFilenamePrefix("2 Become 1"), null, "a bare number is part of the title");
  assert.equal(parseFilenamePrefix("1999 - Prince"), null, "years are not track numbers");
  assert.equal(parseFilenamePrefix("Just a Title"), null);
});

test("suggests missing album artists from the album, or Various Artists", () => {
  const suggestions = suggestForLibrary([
    t("a", { albumArtist: null, artist: "Solo" }),
    t("b", { albumArtist: null, artist: "Solo" }),
    t("c", { relPath: "Mixes/Compilation/c.mp3", album: "Hits", artist: "One", albumArtist: null }),
    t("d", { relPath: "Mixes/Compilation/d.mp3", album: "Hits", artist: "Two", albumArtist: null }),
    t("e", { relPath: "Mixes/Compilation/e.mp3", album: "Hits", artist: "Three", albumArtist: null }),
    // Two artists on a two-track album: not enough evidence to guess.
    t("f", { relPath: "Duo/Split/f.mp3", album: "Split", artist: "A", albumArtist: null }),
    t("g", { relPath: "Duo/Split/g.mp3", album: "Split", artist: "B", albumArtist: null }),
    // The rest of the album already names its album artist: follow it.
    t("h", { relPath: "Band/Rec/h.mp3", album: "Rec", artist: "Band feat. Guest", albumArtist: null }),
    t("i", { relPath: "Band/Rec/i.mp3", album: "Rec", artist: "Band", albumArtist: "Band" }),
  ]).filter((s) => s.field === "albumArtist" && s.rule === "album-artist");
  const by = Object.fromEntries(suggestions.map((s) => [s.trackId, s.newValue]));
  assert.deepEqual(by, { a: "Solo", b: "Solo", c: "Various Artists", d: "Various Artists", e: "Various Artists", h: "Band" });
});

test("suggests titles and track numbers from file names when tags are missing", () => {
  const suggestions = suggestForLibrary([
    t("x", { relPath: "A/B/03 - artist - cool track.mp3", title: "03 - artist - cool track", trackNo: null }),
    t("y", { relPath: "A/B/04 - Tagged Title.mp3", title: "A Real Tag", trackNo: null }),
    t("z", { relPath: "A/B/05 Song.mp3", title: "05 Song", trackNo: 5 }),
  ]);
  const title = suggestions.find((s) => s.trackId === "x" && s.field === "title")!;
  assert.equal(title.newValue, "Cool Track");
  assert.match(title.rule, /title-from-filename/);
  assert.equal(suggestions.find((s) => s.trackId === "x" && s.field === "trackNo")!.newValue, "3");
  assert.equal(suggestions.find((s) => s.trackId === "y" && s.field === "trackNo")!.newValue, "4");
  assert.ok(
    !suggestions.some((s) => s.trackId === "y" && s.field === "title"),
    "a real title tag is never replaced by the file name",
  );
  assert.ok(!suggestions.some((s) => s.trackId === "z" && s.field === "trackNo"), "an existing track number is kept");
});

test("untagged files get artist and album from their Artist/Album folders", () => {
  assert.deepEqual(folderTags("Test Artist/Demo Album/01 Warm Sine.wav"), { artist: "Test Artist", album: "Demo Album" });
  assert.deepEqual(folderTags("Music/Band/Record/01 x.flac"), { artist: "Band", album: "Record" });
  assert.equal(folderTags("Loose/01 x.flac"), null, "one folder is not enough to tell artist from album");
  assert.equal(folderTags("Band/Record/CD2/01 x.flac"), null, "a disc folder is not an album name");
  const out = suggestForLibrary([t("01 Song", { relPath: "Test Artist/Demo Album/01 Song.wav", artist: null, album: null, albumArtist: null, trackNo: null })]);
  const byField = Object.fromEntries(out.map((s) => [s.field, s]));
  assert.equal(byField.artist?.newValue, "Test Artist");
  assert.equal(byField.album?.newValue, "Demo Album");
  assert.equal(byField.artist?.rule, "from-folders");
  // Tags that are already there are never replaced by folder names.
  assert.ok(!suggestForLibrary([t("01 Song", { relPath: "X/Y/01 Song.wav" })]).some((s) => s.rule === "from-folders"));
});
