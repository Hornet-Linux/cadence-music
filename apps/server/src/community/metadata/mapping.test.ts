import assert from "node:assert/strict";
import test from "node:test";
import {
  bandsintownName,
  httpsUrl,
  looksLikeMusicArtist,
  luceneQuoted,
  mapDiscogsArtist,
  mapReleaseGroups,
  mapWikiSummary,
  pickArtist,
  pickRecording,
} from "./mapping.js";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

test("pickArtist prefers an exact name match over a higher-ranked near match", () => {
  const search = { artists: [{ id: ID1, name: "Nirvana UK", score: 100 }, { id: ID2, name: "Nirvana", score: 90 }] };
  assert.equal(pickArtist(search, "nirvana")?.mbid, ID2);
});

test("pickArtist refuses a weak guess", () => {
  assert.equal(pickArtist({ artists: [{ id: ID1, name: "Something Else", score: 70 }] }, "Nirvana"), null);
  assert.equal(pickArtist({ artists: [{ id: "bad-id", name: "Nirvana", score: 100 }] }, "Nirvana"), null);
  assert.equal(pickArtist(null, "Nirvana"), null);
});

test("pickRecording ignores low-confidence hits and finds the earliest year", () => {
  const search = {
    recordings: [
      { id: ID1, title: "Low", score: 40 },
      { id: ID2, title: "Song", score: 100, length: 215000, "artist-credit": [{ name: "A", joinphrase: " & ", artist: { id: ID1 } }, { name: "B" }], releases: [{ id: ID1, title: "Later", date: "2001-05-01" }, { id: ID2, title: "First", date: "1999" }] },
    ],
  };
  const hit = pickRecording(search)!;
  assert.equal(hit.title, "Song");
  assert.equal(hit.artist, "A & B");
  assert.equal(hit.year, 1999);
  assert.equal(hit.lengthSec, 215);
});

test("luceneQuoted escapes quotes and backslashes", () => {
  const bs = String.fromCharCode(92);
  assert.equal(luceneQuoted("He said " + String.fromCharCode(34) + "hi" + String.fromCharCode(34) + " " + bs + " bye"), String.fromCharCode(34) + "He said " + bs + String.fromCharCode(34) + "hi" + bs + String.fromCharCode(34) + " " + bs + bs + " bye" + String.fromCharCode(34));
});

test("httpsUrl upgrades http and rejects other schemes", () => {
  assert.equal(httpsUrl("http://example.com/a"), "https://example.com/a");
  assert.equal(httpsUrl("javascript:alert(1)"), undefined);
  assert.equal(httpsUrl("data:text/html,x"), undefined);
  assert.equal(httpsUrl("not a url"), undefined);
});

test("bandsintownName double-escapes the characters the service treats specially", () => {
  assert.equal(bandsintownName("AC/DC"), "AC%252FDC");
  assert.equal(bandsintownName("What?"), "What%253F");
  assert.equal(bandsintownName("Sigur Rós"), "Sigur%20R%C3%B3s");
});

test("discogs profile markup is reduced to plain text", () => {
  const artist = mapDiscogsArtist({ id: 5, name: "Band", profile: "Formed with [a=Someone Else] and [b]bold[/b].", urls: ["http://band.example/", "ftp://nope"] })!;
  assert.equal(artist.profile, "Formed with Someone Else and bold.");
  assert.deepEqual(artist.links, [{ label: "band.example", url: "https://band.example/" }]);
});

test("release groups sort newest first and skip other artists", () => {
  const credit = (n: string) => [{ name: n }];
  const search = {
    "release-groups": [
      { id: ID1, title: "Old", "first-release-date": "2026-08-01", "artist-credit": credit("Me") },
      { id: ID2, title: "Newer", "first-release-date": "2026-09-10", "artist-credit": credit("ME") },
      { id: ID2, title: "Not Mine", "first-release-date": "2026-09-11", "artist-credit": credit("Them") },
      { id: ID1, title: "No Date", "artist-credit": credit("Me") },
    ],
  };
  assert.deepEqual(mapReleaseGroups(search, "me").map((g) => g.title), ["Newer", "Old"]);
});

test("a disambiguation page is not an artist biography", () => {
  const page = mapWikiSummary({ title: "Nirvana", extract: "Nirvana may refer to:", type: "disambiguation" })!;
  assert.equal(looksLikeMusicArtist(page), false);
  const band = mapWikiSummary({ title: "Nirvana (band)", description: "American rock band", extract: "Nirvana was an American rock band." })!;
  assert.equal(looksLikeMusicArtist(band), true);
});
