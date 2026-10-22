import assert from "node:assert/strict";
import test from "node:test";
import { CandidateIndex, THRESHOLDS, confidenceOf, scoreMatch, wantedKey, type Candidate, type Wanted } from "./matcher.js";
import { artistNames, editDistance, normalizeText, parseTitle, similarity, splitArtists } from "./normalize.js";

const w = (title: string, artist: string, extra: Partial<Wanted> = {}): Wanted => ({ title, artists: [artist], ...extra });
const c = (title: string, artist: string, extra: Partial<Candidate> = {}): Candidate => ({ id: `${title}|${artist}`, title, artists: [artist], ...extra });

test("normalizeText ignores case, accents, punctuation and the ampersand", () => {
  assert.equal(normalizeText("  Beyoncé — Déjà Vu!! "), "beyonce deja vu");
  assert.equal(normalizeText("Don\u2019t Stop Believin'"), "dont stop believin");
  assert.equal(normalizeText("Simon & Garfunkel"), "simon and garfunkel");
  assert.equal(normalizeText("Straße"), "strasse");
  assert.equal(normalizeText("夜に駆ける"), "夜に駆ける");
  assert.equal(normalizeText("Сплин — Выхода нет"), "сплин выхода нет");
  assert.equal(normalizeText("AC/DC"), "ac dc");
});

test("parseTitle removes remaster and edition notes but keeps real words", () => {
  for (const raw of ["Heroes - 2017 Remaster", "Heroes (Remastered 2017)", "Heroes [Mono]", "Heroes (Deluxe Edition)", "Heroes (Radio Edit)", "Heroes (Explicit)", "Heroes - Single Version", "Heroes (From the Motion Picture)"]) {
    assert.deepEqual(parseTitle(raw).base, "heroes", raw);
    assert.equal(parseTitle(raw).flags.size, 0, raw);
  }
  assert.equal(parseTitle("Dance With Me").base, "dance with me");
  assert.deepEqual(parseTitle("Dance With Me").featured, []);
  assert.equal(parseTitle("Imagine (Part 2)").base, "imagine part 2");
});

test("parseTitle finds featured artists in every common spelling", () => {
  assert.deepEqual(parseTitle("Get Lucky (feat. Pharrell Williams & Nile Rodgers)").featured, ["pharrell williams", "nile rodgers"]);
  assert.deepEqual(parseTitle("Get Lucky ft. Pharrell Williams").featured, ["pharrell williams"]);
  assert.deepEqual(parseTitle("Get Lucky - featuring Pharrell Williams").featured, ["pharrell williams"]);
  assert.deepEqual(parseTitle("Get Lucky [with Pharrell Williams]").featured, ["pharrell williams"]);
  assert.equal(parseTitle("Get Lucky (feat. Pharrell Williams)").base, "get lucky");
});

test("parseTitle flags the versions that are different recordings", () => {
  const flags = (s: string) => [...parseTitle(s).flags].sort();
  assert.deepEqual(flags("Hotel California - Live at the Forum"), ["live"]);
  assert.deepEqual(flags("Hotel California (Live)"), ["live"]);
  assert.deepEqual(flags("Hotel California [MTV Unplugged]"), ["live"]);
  assert.deepEqual(flags("One More Time (Remix)"), ["remix"]);
  assert.deepEqual(flags("One More Time (Club Remix)"), ["remix"]);
  assert.deepEqual(flags("One More Time (Radio Mix)"), []);
  assert.deepEqual(flags("One More Time - Original Mix"), []);
  assert.deepEqual(flags("Song (Acoustic Version)"), ["acoustic"]);
  assert.deepEqual(flags("Song (Instrumental)"), ["instrumental"]);
  assert.deepEqual(flags("Song (Karaoke Version)"), ["karaoke"]);
  assert.deepEqual(flags("Song (Demo)"), ["demo"]);
  assert.deepEqual(flags("Song (Live) - 2011 Remaster"), ["live"]);
});

test("artist names are split, normalised and compared without 'the'", () => {
  assert.deepEqual(splitArtists("A & B, C feat. D"), ["A", "B", "C", "D"]);
  assert.ok(artistNames(["The Beatles"]).includes("beatles"));
  assert.ok(artistNames(["Simon & Garfunkel"]).includes("simon and garfunkel"));
  assert.ok(artistNames(["Simon & Garfunkel"]).includes("simon"));
  assert.ok(artistNames(["AC/DC"]).includes("ac dc"));
});

test("similarity: identical, reordered, near and unrelated", () => {
  assert.equal(similarity("abc", "abc"), 1);
  assert.equal(editDistance("kitten", "sitting"), 3);
  assert.ok(similarity("love me do", "do love me") > 0.9);
  assert.ok(similarity("bohemian rhapsody", "bohemain rapsody") > 0.8);
  assert.ok(similarity("yesterday", "tomorrow") < 0.4);
  assert.equal(similarity("", ""), 1);
  assert.equal(similarity("a", ""), 0);
});

test("an exact match scores 1 and is high confidence", () => {
  const s = scoreMatch(w("Blue Monday", "New Order", { album: "Power, Corruption & Lies", durationSec: 449 }), c("Blue Monday", "New Order", { album: "Power, Corruption & Lies", durationSec: 449.6 }));
  assert.ok(s.score >= 0.99, String(s.score));
  assert.equal(s.confidence, "high");
});

test("accents, case and punctuation do not matter", () => {
  assert.equal(scoreMatch(w("Déjà Vu", "Beyoncé"), c("deja vu", "BEYONCE")).confidence, "high");
  assert.equal(scoreMatch(w("Don't Stop Believin'", "Journey"), c("Dont Stop Believin", "Journey")).confidence, "high");
  assert.equal(scoreMatch(w("Mad World", "Tears for Fears"), c("Mad World", "Tears For Fears")).confidence, "high");
});

test("'The' and '&' variations of the artist still match", () => {
  assert.equal(scoreMatch(w("Hey Jude", "The Beatles"), c("Hey Jude", "Beatles")).confidence, "high");
  assert.equal(scoreMatch(w("The Sound of Silence", "Simon & Garfunkel"), c("The Sound of Silence", "Simon and Garfunkel")).confidence, "high");
});

test("feat. notes in the title, in the artist, or only on one side still match", () => {
  const library = c("Get Lucky", "Daft Punk", { durationSec: 369 });
  assert.equal(scoreMatch(w("Get Lucky (feat. Pharrell Williams)", "Daft Punk", { durationSec: 369 }), library).confidence, "high");
  assert.equal(scoreMatch(w("Get Lucky", "Daft Punk feat. Pharrell Williams", { durationSec: 369 }), library).confidence, "high");
  const both = c("Get Lucky", "Daft Punk, Pharrell Williams", { durationSec: 369 });
  assert.equal(scoreMatch(w("Get Lucky - feat. Pharrell Williams", "Daft Punk"), both).confidence, "high");
  assert.equal(scoreMatch(w("Get Lucky", "Daft Punk"), both).confidence, "high");
});

test("remaster notes on either side are ignored", () => {
  assert.equal(scoreMatch(w("Heroes - 2017 Remaster", "David Bowie"), c("Heroes", "David Bowie")).confidence, "high");
  assert.equal(scoreMatch(w("Heroes", "David Bowie", { album: "Heroes" }), c("Heroes (Remastered)", "David Bowie", { album: "Heroes (2017 Remaster)" })).confidence, "high");
});

test("a live version is not accepted for the studio track, and the studio one ranks first", () => {
  const studio = c("Hotel California", "Eagles", { durationSec: 391 });
  const live = c("Hotel California (Live)", "Eagles", { durationSec: 411 });
  const wantStudio = w("Hotel California", "Eagles", { durationSec: 391 });
  assert.ok(scoreMatch(wantStudio, studio).score > scoreMatch(wantStudio, live).score + 0.1);
  assert.notEqual(scoreMatch(wantStudio, live).confidence, "high");
  const index = new CandidateIndex([live, studio]);
  assert.equal(index.search(wantStudio)[0].candidate.id, studio.id);
  // Asking for the live version picks the live one.
  const wantLive = w("Hotel California - Live", "Eagles", { durationSec: 411 });
  assert.equal(index.search(wantLive)[0].candidate.id, live.id);
});

test("remix, acoustic and instrumental versions are told apart", () => {
  const original = c("One More Time", "Daft Punk");
  const remix = c("One More Time (Remix)", "Daft Punk");
  const want = w("One More Time", "Daft Punk");
  assert.ok(scoreMatch(want, original).score > scoreMatch(want, remix).score);
  assert.ok(scoreMatch(w("One More Time (Instrumental)", "Daft Punk"), c("One More Time (Instrumental)", "Daft Punk")).score > 0.95);
  assert.ok(scoreMatch(w("Song (Acoustic)", "A"), c("Song", "A")).score < THRESHOLDS.high);
});

test("same title by a different artist is not a match", () => {
  const s = scoreMatch(w("Hurt", "Johnny Cash"), c("Hurt", "Nine Inch Nails"));
  assert.ok(s.score <= 0.6, String(s.score));
  assert.notEqual(s.confidence, "high");
  assert.notEqual(s.confidence, "medium");
});

test("a similar artist with a different title is not a match", () => {
  const s = scoreMatch(w("Paranoid Android", "Radiohead"), c("Karma Police", "Radiohead"));
  assert.equal(s.confidence, "none");
});

test("a very different length lowers the score", () => {
  const same = scoreMatch(w("Song", "Band", { durationSec: 200 }), c("Song", "Band", { durationSec: 201 })).score;
  const near = scoreMatch(w("Song", "Band", { durationSec: 200 }), c("Song", "Band", { durationSec: 208 })).score;
  const far = scoreMatch(w("Song", "Band", { durationSec: 200 }), c("Song", "Band", { durationSec: 420 })).score;
  assert.ok(same > near && near > far, `${same} ${near} ${far}`);
  assert.notEqual(confidenceOf(far), "high");
});

test("small spelling mistakes still reach medium confidence or better", () => {
  const s = scoreMatch(w("Bohemain Rapsody", "Queen"), c("Bohemian Rhapsody", "Queen", { durationSec: 355 }));
  assert.ok(s.score >= THRESHOLDS.medium, String(s.score));
});

test("without an artist a title match is never high confidence", () => {
  const s = scoreMatch({ title: "Blue Monday", artists: [] }, c("Blue Monday", "New Order"));
  assert.ok(s.score <= 0.7);
  assert.notEqual(s.confidence, "high");
});

test("works for non-Latin scripts", () => {
  assert.equal(scoreMatch(w("夜に駆ける", "YOASOBI"), c("夜に駆ける", "YOASOBI")).confidence, "high");
  assert.equal(scoreMatch(w("Группа крови", "Кино"), c("Группа крови", "Кино")).confidence, "high");
  assert.equal(scoreMatch(w("夜に駆ける", "YOASOBI"), c("群青", "YOASOBI")).confidence, "none");
});

test("title words that look like notes are kept (Dance With Me, From Paris, Mono)", () => {
  assert.equal(scoreMatch(w("Dance With Me", "Orleans"), c("Dance", "Orleans")).confidence === "high", false);
  assert.equal(scoreMatch(w("Dance With Me", "Orleans"), c("Dance With Me", "Orleans")).confidence, "high");
  assert.equal(scoreMatch(w("Mono", "Eddie Vedder"), c("Mono", "Eddie Vedder")).confidence, "high");
});

test("the index returns ranked candidates and ignores the rest", () => {
  const library: Candidate[] = [
    c("Yesterday", "The Beatles", { durationSec: 125 }),
    c("Yesterday (Live)", "The Beatles", { durationSec: 140 }),
    c("Yesterday", "Boyz II Men"),
    c("Tomorrow", "The Beatles"),
    c("Something", "The Beatles"),
  ];
  const index = new CandidateIndex(library);
  const hits = index.search(w("Yesterday - Remastered 2009", "The Beatles", { durationSec: 125 }), 3);
  assert.equal(hits[0].candidate.id, "Yesterday|The Beatles");
  assert.equal(hits[0].confidence, "high");
  assert.ok(hits.every((h) => h.score >= THRESHOLDS.low));
  assert.equal(index.search(w("Nothing like this exists", "Nobody")).length, 0);
});

test("matching 300 tracks against a 20,000 track library is fast", () => {
  const words = ["blue", "night", "river", "fire", "moon", "city", "heart", "road", "dream", "light", "storm", "gold", "ocean", "wind", "stone", "ghost"];
  const library: Candidate[] = [];
  for (let i = 0; i < 20_000; i++) {
    library.push(c(`${words[i % 16]} ${words[(i * 7) % 16]} ${i}`, `Artist ${i % 500}`, { durationSec: 150 + (i % 100) }));
  }
  const started = Date.now();
  const index = new CandidateIndex(library);
  let found = 0;
  for (let i = 0; i < 300; i++) {
    const n = i * 61;
    const hit = index.search(w(`${words[n % 16]} ${words[(n * 7) % 16]} ${n}`, `Artist ${n % 500}`, { durationSec: 150 + (n % 100) }), 1)[0];
    if (hit && hit.candidate.id === `${words[n % 16]} ${words[(n * 7) % 16]} ${n}|Artist ${n % 500}`) found++;
  }
  assert.equal(found, 300);
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
});

test("wantedKey merges duplicates of the same song", () => {
  assert.equal(wantedKey(w("Heroes - 2017 Remaster", "David Bowie")), wantedKey(w("HEROES", "david bowie")));
  assert.notEqual(wantedKey(w("Heroes", "David Bowie")), wantedKey(w("Heroes", "Other")));
});

test("confidence bands", () => {
  assert.equal(confidenceOf(0.9), "high");
  assert.equal(confidenceOf(0.7), "medium");
  assert.equal(confidenceOf(0.5), "low");
  assert.equal(confidenceOf(0.2), "none");
});