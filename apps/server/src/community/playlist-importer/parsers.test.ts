import assert from "node:assert/strict";
import test from "node:test";
import { detectFormat, fromFileName, parseDuration, parseImport, parsePlist } from "./parsers.js";
import { parseDelimited } from "./tabular.js";

test("M3U: EXTINF gives artist, title and length; file names are the fallback", () => {
  const text = [
    "\uFEFF#EXTM3U",
    "#PLAYLIST:Road trip",
    "#EXTINF:215,Queen - Bohemian Rhapsody",
    "Queen/A Night at the Opera/11 Bohemian Rhapsody.flac",
    "#EXTINF:-1,Untitled stream",
    "http://example.com/stream",
    "C:\\Music\\Daft Punk\\03 - Daft Punk - Digital Love.mp3",
    "",
  ].join("\r\n");
  const r = parseImport(text, { filename: "trip.m3u8" });
  assert.equal(r.format, "m3u");
  assert.equal(r.name, "Road trip");
  assert.deepEqual(r.items.map((i) => [i.title, i.artists[0] ?? null, i.durationSec ?? null]), [
    ["Bohemian Rhapsody", "Queen", 215],
    ["Untitled stream", null, null],
    ["Digital Love", "Daft Punk", null],
  ]);
});

test("M3U without headers: lines of 'Artist - Title' work", () => {
  const r = parseImport("Radiohead - Creep\nBjörk - Hyperballad\n");
  assert.equal(r.format, "m3u");
  assert.deepEqual(r.items.map((i) => `${i.artists[0]}|${i.title}`), ["Radiohead|Creep", "Björk|Hyperballad"]);
});

test("file names: numbering, folders, extensions and percent-encoding are removed", () => {
  assert.deepEqual(fromFileName("/m/Band/01 - Band - Song%20One.mp3"), { artists: ["Band"], title: "Song One" });
  assert.deepEqual(fromFileName("07. Just A Title.flac"), { artists: [], title: "Just A Title" });
});

test("XSPF: titles, creators, album, milliseconds and entities", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<playlist version="1" xmlns="http://xspf.org/ns/0/"><title>Mix &amp; Match</title><trackList>
<track><location>file:///a.mp3</location><title>Fish &amp; Chips</title><creator>The Smiths</creator><album><![CDATA[Louder <Than> Bombs]]></album><duration>201400</duration></track>
<track><location>file:///music/Artist%20-%20Only%20File.mp3</location></track>
</trackList></playlist>`;
  const r = parseImport(xml, { filename: "x.xspf" });
  assert.equal(r.format, "xspf");
  assert.equal(r.name, "Mix & Match");
  assert.deepEqual(r.items[0], { title: "Fish & Chips", artists: ["The Smiths"], album: "Louder <Than> Bombs", durationSec: 201.4, count: 1 });
  assert.equal(r.items[1].title, "Only File");
  assert.deepEqual(r.items[1].artists, ["Artist"]);
});

test("CSV: Exportify (Spotify) columns with quotes, commas and milliseconds", () => {
  const csv = [
    '"Track URI","Track Name","Album Name","Artist Name(s)","Duration (ms)"',
    '"spotify:track:1","Hello, World","Greatest ""Hits""","Artist A;Artist B","215000"',
    '"spotify:track:2","Second","Album","Solo","61000"',
  ].join("\n");
  const r = parseImport(csv, { filename: "playlist.csv" });
  assert.equal(r.format, "csv");
  assert.deepEqual(r.items[0], { title: "Hello, World", artists: ["Artist A", "Artist B"], album: 'Greatest "Hits"', durationSec: 215, count: 1 });
  assert.equal(r.items[1].durationSec, 61);
});

test("CSV: Last.fm scrobbles are merged and ranked by play count", () => {
  const rows = ["utc_time,artist,artist_mbid,album,album_mbid,track,track_mbid"];
  const add = (n: number, artist: string, track: string) => {
    for (let i = 0; i < n; i++) rows.push(`2024-01-0${(i % 9) + 1} 10:00,${artist},,,,${track},`);
  };
  add(1, "Radiohead", "Creep");
  add(4, "Boards of Canada", "Roygbiv");
  add(2, "radiohead", "CREEP");
  const r = parseImport(rows.join("\n"));
  assert.deepEqual(r.items.map((i) => [i.title, i.count]), [["Roygbiv", 4], ["Creep", 3]]);
  assert.equal(r.items.length, 2);
});

test("CSV: semicolon and tab delimiters, Apple Music text export with m:ss times", () => {
  const apple = "Name\tArtist\tAlbum\tTime\nSomething\tThe Beatles\tAbbey Road\t3:03\nHey Jude\tThe Beatles\t1\t7:11";
  const r = parseImport(apple, { filename: "Library.txt" });
  assert.deepEqual(r.items.map((i) => [i.title, i.durationSec]), [["Something", 183], ["Hey Jude", 431]]);
  const semi = parseImport("title;artist\nA;B\nC;D");
  assert.equal(semi.items.length, 2);
  assert.deepEqual(parseDelimited('a,"b\nc",d\n1,2,3'), [["a", "b\nc", "d"], ["1", "2", "3"]]);
});

test("CSV without a title column explains what is needed", () => {
  const r = parseImport("foo,bar\n1,2");
  assert.equal(r.items.length, 0);
  assert.match(r.warnings[0], /No title column/);
});

test("JSON: Apple Music privacy export, Spotify library and streaming history, our own export", () => {
  const apple = JSON.stringify([{ Title: "Intro", Artist: "The xx", Album: "xx", "Track Duration": 127000 }, { Title: "Islands", Artist: "The xx" }]);
  const a = parseImport(apple, { filename: "Apple Music Library Tracks.json" });
  assert.deepEqual(a.items.map((i) => [i.title, i.durationSec]), [["Intro", 127], ["Islands", undefined]]);

  const spotifyLibrary = JSON.stringify({ tracks: [{ artist: "Air", album: "Moon Safari", track: "La Femme d'Argent", uri: "spotify:track:1" }] });
  assert.equal(parseImport(spotifyLibrary).items[0].title, "La Femme d'Argent");

  // msPlayed is how long it was listened to, not the track length.
  const history = JSON.stringify([{ endTime: "2024-01-01 10:00", artistName: "Air", trackName: "Sexy Boy", msPlayed: 4000 }, { endTime: "2024-01-02 10:00", artistName: "Air", trackName: "Sexy Boy", msPlayed: 300000 }]);
  const h = parseImport(history);
  assert.equal(h.items.length, 1);
  assert.equal(h.items[0].count, 2);
  assert.equal(h.items[0].durationSec, undefined);

  const extended = JSON.stringify([
    { master_metadata_track_name: "Roygbiv", master_metadata_album_artist_name: "Boards of Canada", master_metadata_album_album_name: "Music Has the Right to Children", ms_played: 1000 },
    { master_metadata_track_name: null, episode_name: "A podcast" },
  ]);
  const e = parseImport(extended);
  assert.deepEqual(e.items.map((i) => [i.title, i.artists[0], i.album]), [["Roygbiv", "Boards of Canada", "Music Has the Right to Children"]]);

  const own = JSON.stringify({ name: "Evening", tracks: [{ id: "x", title: "Song", artists: [{ name: "A" }, { name: "B" }], album: "Al", durationSec: 90 }] });
  const o = parseImport(own);
  assert.equal(o.name, "Evening");
  assert.deepEqual(o.items[0].artists, ["A", "B"]);

  const spotifyApi = JSON.stringify({ items: [{ track: { name: "Teardrop", artists: [{ name: "Massive Attack" }], album: { name: "Mezzanine" }, duration_ms: 330000 } }] });
  assert.equal(parseImport(spotifyApi).items[0].artists[0], "Massive Attack");

  assert.match(parseImport("{not json", { format: "json" }).warnings[0], /not valid JSON/);
});

const plist = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${inner}</dict></plist>`;
const track = (id: number, name: string, artist: string, ms: number) =>
  `<key>${id}</key><dict><key>Track ID</key><integer>${id}</integer><key>Name</key><string>${name}</string><key>Artist</key><string>${artist}</string><key>Total Time</key><integer>${ms}</integer></dict>`;

test("Apple Music / iTunes library XML: one playlist is imported, several ask which", () => {
  const tracks = `<key>Tracks</key><dict>${track(1, "Windowlicker", "Aphex Twin", 366000)}${track(2, "Xtal", "Aphex Twin &amp; Friends", 290000)}</dict>`;
  const list = (id: number, name: string, ids: number[]) =>
    `<dict><key>Name</key><string>${name}</string><key>Playlist ID</key><integer>${id}</integer><key>Playlist Items</key><array>${ids.map((i) => `<dict><key>Track ID</key><integer>${i}</integer></dict>`).join("")}</array></dict>`;
  const master = `<dict><key>Name</key><string>Library</string><key>Master</key><true/><key>Playlist Items</key><array>${list(0, "x", [1]).slice(0, 0)}</array></dict>`;
  const one = plist(`${tracks}<key>Playlists</key><array>${master}${list(10, "Warp", [1, 2])}</array>`);
  const r = parseImport(one, { filename: "Library.xml" });
  assert.equal(r.format, "itunes-xml");
  assert.equal(r.name, "Warp");
  assert.deepEqual(r.items.map((i) => [i.title, i.artists[0], i.durationSec]), [["Windowlicker", "Aphex Twin", 366], ["Xtal", "Aphex Twin & Friends", 290]]);

  const many = plist(`${tracks}<key>Playlists</key><array>${list(10, "Warp", [1, 2])}${list(11, "Chill", [2])}</array>`);
  const choose = parseImport(many, { filename: "Library.xml" });
  assert.equal(choose.items.length, 0);
  assert.deepEqual(choose.choices?.map((c) => [c.id, c.name, c.trackCount]), [["10", "Warp", 2], ["11", "Chill", 1]]);
  assert.deepEqual(parseImport(many, { playlist: "11" }).items.map((i) => i.title), ["Xtal"]);
  assert.deepEqual(parseImport(many, { playlist: "Chill" }).items.map((i) => i.title), ["Xtal"]);
  assert.match(parseImport("<plist><dict></dict></plist>", { format: "itunes-xml" }).warnings[0], /does not look like/);
});

test("plist parser handles nesting, booleans and entities", () => {
  const value = parsePlist("<dict><key>a</key><array><string>x &amp; y</string><true/><integer>3</integer></array><key>b</key><dict><key>c</key><string/></dict></dict>");
  assert.deepEqual(value, { a: ["x & y", true, 3], b: { c: "" } });
});

test("durations come as clock times, seconds or milliseconds", () => {
  assert.equal(parseDuration("3:45"), 225);
  assert.equal(parseDuration("1:02:03"), 3723);
  assert.equal(parseDuration("225"), 225);
  assert.equal(parseDuration("225000"), 225);
  assert.equal(parseDuration("225000", "durationms"), 225);
  assert.equal(parseDuration(215.4), 215.4);
  assert.equal(parseDuration(""), undefined);
  assert.equal(parseDuration("abc"), undefined);
  assert.equal(parseDuration(-4), undefined);
});

test("format detection looks at the content before the name", () => {
  assert.equal(detectFormat("#EXTM3U\n", "weird.txt"), "m3u");
  assert.equal(detectFormat('<playlist xmlns="http://xspf.org/ns/0/">'), "xspf");
  assert.equal(detectFormat("<plist></plist>"), "itunes-xml");
  assert.equal(detectFormat("[]"), "json");
  assert.equal(detectFormat("a,b\n1,2", "x.csv"), "csv");
});

test("a huge file is capped and says so", () => {
  const rows = ["title,artist"];
  for (let i = 0; i < 20_050; i++) rows.push(`Song ${i},Artist`);
  const r = parseImport(rows.join("\n"));
  assert.equal(r.items.length, 20_000);
  assert.ok(r.warnings.some((w) => /first 20000/.test(w)));
});