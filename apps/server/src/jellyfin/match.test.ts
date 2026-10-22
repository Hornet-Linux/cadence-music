import { test } from "node:test";
import assert from "node:assert/strict";
import { artistKeys, normalizeTitle, pickBest, scoreCandidate, searchTitle } from "./match.js";
import { signedPath, verifySigned } from "./signing.js";
import { parseJellyfinUrl } from "./url.js";

test("titles ignore case, accents, punctuation and edition noise", () => {
  assert.equal(normalizeTitle("Café del Mar"), normalizeTitle("cafe DEL mar"));
  assert.equal(normalizeTitle("One More Time (Remastered)"), "one more time");
  assert.equal(normalizeTitle("One More Time - 2011 Remaster"), "one more time");
  assert.equal(normalizeTitle("One More Time (Remastered 2011)"), "one more time");
  assert.equal(normalizeTitle("Instant Crush (feat. Julian Casablancas)"), "instant crush");
  assert.equal(normalizeTitle("Instant Crush [ft. Julian Casablancas]"), "instant crush");
  assert.equal(normalizeTitle("Instant Crush feat. Julian Casablancas"), "instant crush");
  assert.equal(normalizeTitle("D.A.N.C.E."), "dance");
  assert.equal(normalizeTitle("Don't Stop Believin’"), normalizeTitle("Dont stop believin"));
  assert.equal(normalizeTitle("Rock & Roll"), normalizeTitle("Rock and Roll"));
  // A live version or a remix is a different recording.
  assert.notEqual(normalizeTitle("Digital Love (Live)"), normalizeTitle("Digital Love"));
  assert.notEqual(normalizeTitle("Odessa (Remix)"), normalizeTitle("Odessa"));
  assert.equal(searchTitle("Get Lucky (Remastered) "), "Get Lucky");
  assert.equal(searchTitle("(Remastered)"), "(Remastered)");
});

test("artists: credits, 'the', ampersands and lists", () => {
  assert.deepEqual(artistKeys("The Beatles"), ["beatles"]);
  assert.ok(artistKeys("Daft Punk feat. Pharrell Williams").includes("daft punk"));
  const keys = artistKeys("Simon & Garfunkel");
  assert.ok(keys.includes("simon") && keys.includes("garfunkel") && keys.includes("simon and garfunkel"));
});

test("a candidate must match both artist and title closely", () => {
  const pick = { artist: "daft punk", title: "ONE MORE TIME (Remastered)" };
  assert.ok(scoreCandidate(pick, { title: "One More Time", artists: ["Daft Punk"] }) > 0.9);
  // Right title, wrong artist: no.
  assert.equal(scoreCandidate(pick, { title: "One More Time", artists: ["Kylie Minogue"] }), 0);
  // Right artist, other song: no.
  assert.equal(scoreCandidate(pick, { title: "Digital Love", artists: ["Daft Punk"] }), 0);
  // A small typo in a long title is fine; in a short one it is another word.
  assert.ok(scoreCandidate({ artist: "Daft Punk", title: "Harder Better Faster Stronge" }, { title: "Harder, Better, Faster, Stronger", artists: ["Daft Punk"] }) > 0);
  assert.equal(scoreCandidate({ artist: "Daft Punk", title: "Lose" }, { title: "Love", artists: ["Daft Punk"] }), 0);
  // Credits on either side.
  assert.ok(scoreCandidate({ artist: "Daft Punk", title: "Get Lucky" }, { title: "Get Lucky", artists: ["Daft Punk", "Pharrell Williams"] }) > 0.9);
  assert.ok(scoreCandidate({ artist: "Daft Punk & Pharrell Williams", title: "Get Lucky" }, { title: "Get Lucky", artists: ["Daft Punk"] }) > 0.9);
  assert.equal(scoreCandidate({ artist: "", title: "" }, { title: "", artists: [] }), 0);
});

test("pickBest takes the closest candidate, or none", () => {
  const candidates = [
    { title: "One More Time (Live)", artists: ["Daft Punk"] },
    { title: "One More Time", artists: ["Daft Punk"] },
    { title: "One More Time", artists: ["Somebody Else"] },
  ];
  assert.equal(pickBest({ artist: "Daft Punk", title: "One More Time" }, candidates), 1);
  assert.equal(pickBest({ artist: "Daft Punk", title: "Nothing Here" }, candidates), -1);
  assert.equal(pickBest({ artist: "Daft Punk", title: "x" }, []), -1);
});

test("signed URLs: kind, user, item and expiry are all bound", () => {
  const secret = "k".repeat(64);
  const id = "a".repeat(32);
  const now = 1_000_000;
  const parse = (path: string) => Object.fromEntries(new URL(path, "http://x/").searchParams) as { u: string; exp: string; sig: string };
  const path = signedPath(secret, "stream", 5, id, now + 100);
  assert.ok(path.startsWith(`api/jellyfin/stream/${id}?u=5&exp=${now + 100}&sig=`));
  const q = parse(path);
  assert.equal(verifySigned(secret, "stream", id, q, now), 5);
  assert.equal(verifySigned(secret, "image", id, q, now), null, "a stream signature is no image signature");
  assert.equal(verifySigned(secret, "stream", "b".repeat(32), q, now), null);
  assert.equal(verifySigned(secret, "stream", id, { ...q, u: "6" }, now), null, "another user");
  assert.equal(verifySigned(secret, "stream", id, { ...q, exp: String(now + 101) }, now), null);
  assert.equal(verifySigned(secret, "stream", id, q, now + 101), null, "expired");
  assert.equal(verifySigned("z".repeat(64), "stream", id, q, now), null, "other server secret");
  assert.equal(verifySigned(secret, "stream", id, { u: "5", exp: q.exp }, now), null);
  assert.equal(verifySigned(secret, "stream", id, { ...q, sig: "" }, now), null);
  assert.equal(verifySigned(secret, "stream", id, { ...q, u: "-5" }, now), null);
});

test("the Jellyfin address: http(s) only, no credentials, query or fragment", () => {
  assert.equal(parseJellyfinUrl("http://jellyfin:8096"), "http://jellyfin:8096");
  assert.equal(parseJellyfinUrl(" https://media.example.com/ "), "https://media.example.com");
  assert.equal(parseJellyfinUrl("https://example.com/jellyfin///"), "https://example.com/jellyfin");
  for (const bad of ["", "   ", "jellyfin:8096", "ftp://x", "file:///etc/passwd", "javascript:alert(1)", "http://u:p@host", "http://u@host", "http://host?x=1", "http://host#a", "http://host/?", "http://", "http://ho st"]) {
    assert.throws(() => parseJellyfinUrl(bad), /./, bad);
  }
});
