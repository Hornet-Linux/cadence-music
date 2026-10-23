import assert from "node:assert/strict";
import test from "node:test";
import { makeApp } from "../_ops/testkit.js";
import plugin from "./plugin.js";

interface MatchResponse {
  libraryTracks: number;
  results: { index: number; candidates: { score: number; confidence: string; source: string; id: string; track?: { id: string; title: string } }[] }[];
}

test("parse then match against the server library, with extra candidates from other sources", async () => {
  const t = await makeApp([plugin]);
  try {
    const insert = t.db.prepare("INSERT INTO tracks (id, rel_path, title, artist, album, duration_sec, size, mtime_ms, added_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1)");
    insert.run("a1", "Queen/bohemian.flac", "Bohemian Rhapsody (Remastered 2011)", "Queen", "A Night at the Opera", 354.5);
    insert.run("a2", "Queen/bohemian-live.flac", "Bohemian Rhapsody (Live)", "Queen", "Live Killers", 360);
    insert.run("a3", "Beyonce/halo.flac", "Halo", "Beyoncé", "I Am... Sasha Fierce", 261);
    insert.run("a4", "Other/halo.flac", "Halo", "Texas", "Hush", 200);

    const user = t.auth(t.userToken);
    assert.equal((await t.app.inject({ method: "POST", url: "/api/import/parse", payload: { text: "x" } })).statusCode, 401);
    assert.equal((await t.app.inject({ method: "POST", url: "/api/import/parse", headers: user, payload: {} })).statusCode, 400);

    const parsed = await t.app.inject({
      method: "POST",
      url: "/api/import/parse",
      headers: user,
      payload: { filename: "mix.m3u", text: "#EXTM3U\n#PLAYLIST:Mix\n#EXTINF:355,Queen - Bohemian Rhapsody\nq.flac\n#EXTINF:261,Beyonce - Halo\nb.flac\n#EXTINF:100,Nobody - Imaginary Song\nn.flac\n" },
    });
    assert.equal(parsed.statusCode, 200);
    const body = parsed.json() as { name: string; items: { title: string; artists: string[]; durationSec?: number }[] };
    assert.equal(body.name, "Mix");
    assert.equal(body.items.length, 3);

    const matched = await t.app.inject({
      method: "POST",
      url: "/api/import/match",
      headers: user,
      payload: { items: body.items, extra: [{ id: "spotify:track:9", title: "Imaginary Song", artists: ["Nobody"], durationSec: 100 }] },
    });
    assert.equal(matched.statusCode, 200);
    const result = matched.json() as MatchResponse;
    assert.equal(result.libraryTracks, 4);
    const [queen, halo, imaginary] = result.results;
    assert.equal(queen.candidates[0].id, "a1", "studio version beats live");
    assert.equal(queen.candidates[0].confidence, "high");
    assert.equal(queen.candidates[0].track?.id, "server:a1");
    assert.equal(halo.candidates[0].id, "a3");
    assert.ok(!halo.candidates.some((c) => c.id === "a4" && c.confidence === "high"));
    assert.equal(imaginary.candidates[0].source, "extra");
    assert.equal(imaginary.candidates[0].id, "spotify:track:9");

    // Bad input is refused rather than guessed at.
    assert.equal((await t.app.inject({ method: "POST", url: "/api/import/match", headers: user, payload: { items: [] } })).statusCode, 400);
    const tooMany = Array.from({ length: 501 }, () => ({ title: "x", artists: [] }));
    assert.equal((await t.app.inject({ method: "POST", url: "/api/import/match", headers: user, payload: { items: tooMany } })).statusCode, 400);
    const junk = await t.app.inject({ method: "POST", url: "/api/import/match", headers: user, payload: { items: [null, { title: "" }, 5] } });
    assert.deepEqual((junk.json() as MatchResponse).results.map((r) => r.candidates.length), [0, 0, 0]);
  } finally {
    await t.cleanup();
  }
});