import { test } from "node:test";
import assert from "node:assert/strict";
import { makeKit, type Kit } from "../_serverlib/testkit.js";
import { makeWav, sine } from "../_serverlib/wav.js";
import loudness from "../loudness/plugin.js";
import tagSuggestions from "../tag-suggestions/plugin.js";
import { factsIndexer } from "../_serverlib/facts.js";
import smart from "./plugin.js";

const wav = (tags: Parameters<typeof makeWav>[3], seconds = 1) =>
  makeWav(seconds, sine(300 + (tags?.track ?? 0) * 20), 8000, tags);

async function setup() {
  const kit = await makeKit([smart, loudness, tagSuggestions], {
    "Rock/a.wav": wav({ title: "Loud Rock", artist: "The Band", album: "Noise", genre: "Rock", year: 1994, track: 1 }),
    "Rock/b.wav": wav({ title: "Quiet Rock", artist: "The Band", album: "Noise", genre: "Rock", year: 1996, track: 2 }, 2),
    "Jazz/c.wav": wav({ title: "Blue", artist: "Miles", album: "Kind", genre: "Jazz", year: 1959, track: 3 }, 3),
    "Pop/d.wav": wav({ title: "Bright", artist: "Star", album: "Hits", genre: "Pop", year: 2022, track: 4 }, 4),
    "Pop/e.wav": wav({ title: "night train", artist: "Star", album: "Hits", genre: "Pop", year: 2022, track: 5 }, 5),
  });
  // Genre and year are read from the files by the shared tag indexer (a background job in the real server).
  await factsIndexer(kit.db, kit.musicDir).start();
  return kit;
}

async function idOf(kit: Kit, title: string) {
  const list = (await kit.app.inject({ method: "GET", url: "/api/tracks", headers: kit.member })).json();
  return (list.items as { id: string; title: string }[]).find((t) => t.title === title)!.id;
}

const call = (kit: Kit, headers: Kit["member"], method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
  kit.app.inject({ method, url, headers, payload });

test("smart playlists are stored per person and evaluated against tags, plays and favourites", async () => {
  const kit = await setup();
  try {
    const memberId = (kit.db.prepare("SELECT id FROM users WHERE username = 'member'").get() as { id: number }).id;
    const loudRock = await idOf(kit, "Loud Rock");
    const quietRock = await idOf(kit, "Quiet Rock");
    const blue = await idOf(kit, "Blue");
    const now = Date.now();
    const play = kit.db.prepare(
      "INSERT INTO plays (user_id, track_id, source, title, artists, played_at) VALUES (?, ?, 'server', ?, '[]', ?)",
    );
    for (let i = 0; i < 5; i++) play.run(memberId, `server:${loudRock}`, "Loud Rock", now - i * 1000);
    play.run(memberId, `server:${blue}`, "Blue", now - 90 * 86_400_000);
    kit.db
      .prepare("INSERT INTO likes (user_id, track_id, track, liked_at) VALUES (?, ?, '{}', ?)")
      .run(memberId, `server:${quietRock}`, now);
    const loud = kit.db.prepare("UPDATE track_loudness SET lufs = ?, error = NULL WHERE track_id = ?");
    for (const [id, lufs] of [
      [loudRock, -8],
      [quietRock, -20],
      [blue, -16],
    ] as const) {
      kit.db
        .prepare("INSERT INTO track_loudness (track_id, lufs, size, mtime_ms, analysed_at) VALUES (?, NULL, 0, 0, 0)")
        .run(id);
      loud.run(lufs, id);
    }

    const create = async (name: string, definition: object, headers = kit.member) => {
      const res = await call(kit, headers, "POST", "/api/smart-playlists", { name, definition });
      assert.equal(res.statusCode, 201, JSON.stringify(res.json()));
      return res.json() as { id: string };
    };
    const tracksOf = async (id: string, query = "") =>
      (await call(kit, kit.member, "GET", `/api/smart-playlists/${id}/tracks${query}`)).json() as {
        total: number;
        items: { title: string; playCount: number; favourite: boolean; genre: string | null }[];
      };

    const rock = await create("Rock", { rules: [{ field: "genre", op: "is", value: "rock" }], sort: { by: "year", dir: "asc" } });
    assert.deepEqual(
      (await tracksOf(rock.id)).items.map((t) => t.title),
      ["Loud Rock", "Quiet Rock"],
    );

    const heavy = await create("Often played", { rules: [{ field: "playCount", op: "gte", value: 3 }] });
    const played = await tracksOf(heavy.id);
    assert.deepEqual(
      played.items.map((t) => [t.title, t.playCount]),
      [["Loud Rock", 5]],
    );

    const favs = await create("Favourites", { rules: [{ field: "favourite", op: "is", value: true }] });
    assert.deepEqual(
      (await tracksOf(favs.id)).items.map((t) => t.title),
      ["Quiet Rock"],
    );

    const quiet = await create("Quiet", {
      rules: [{ field: "loudness", op: "lt", value: -15 }],
      sort: { by: "loudness", dir: "asc" },
    });
    assert.deepEqual(
      (await tracksOf(quiet.id)).items.map((t) => t.title),
      ["Quiet Rock", "Blue"],
    );

    const mix = await create("Forgotten jazz or new pop", {
      match: "any",
      rules: [
        { field: "genre", op: "is", value: "Jazz" },
        { field: "year", op: "gte", value: 2020 },
      ],
      limit: 1,
      sort: { by: "year", dir: "desc" },
    });
    const limited = await tracksOf(mix.id);
    assert.equal(limited.total, 3);
    assert.deepEqual(
      limited.items.map((t) => t.title),
      ["Bright"],
    );

    const lapsed = await create("Not heard lately", {
      rules: [{ field: "lastPlayed", op: "notInLast", value: 30 }],
      sort: { by: "title", dir: "asc" },
    });
    assert.deepEqual(
      (await tracksOf(lapsed.id)).items.map((t) => t.title),
      ["Blue", "Bright", "night train", "Quiet Rock"],
    );

    // Other people's plays and favourites do not count for me, and their playlists are private.
    const adminRock = await call(kit, kit.admin, "GET", `/api/smart-playlists/${heavy.id}/tracks`);
    assert.equal(adminRock.statusCode, 404);
    assert.deepEqual((await call(kit, kit.admin, "GET", "/api/smart-playlists")).json().items, []);

    // A tag suggestion the admin accepted is what the rules see (the library API shows it too).
    await call(kit, kit.admin, "POST", "/api/tag-suggestions/scan");
    const fix = (await call(kit, kit.admin, "GET", "/api/tag-suggestions"))
      .json()
      .items.find((s: { newValue: string }) => s.newValue === "Night Train");
    assert.ok(fix, "the lower-case title is flagged");
    const nightRule = await create("Night", { rules: [{ field: "title", op: "is", value: "Night Train" }] });
    assert.deepEqual(
      (await tracksOf(nightRule.id)).items.map((t) => t.title),
      ["night train"],
      "before accepting, the file tag is what shows",
    );
    await call(kit, kit.admin, "POST", `/api/tag-suggestions/${fix.id}/accept`, {});
    assert.deepEqual(
      (await tracksOf(nightRule.id)).items.map((t) => t.title),
      ["Night Train"],
    );
    await call(kit, kit.member, "DELETE", `/api/smart-playlists/${nightRule.id}`);

    // Preview, update, delete, validation.
    const preview = (
      await call(kit, kit.member, "POST", "/api/smart-playlists/preview", {
        definition: { rules: [{ field: "year", op: "lt", value: 2000 }] },
      })
    ).json();
    assert.equal(preview.total, 3);
    assert.equal(
      (
        await call(kit, kit.member, "POST", "/api/smart-playlists/preview", {
          definition: { rules: [{ field: "nope", op: "is", value: 1 }] },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await call(kit, kit.member, "POST", "/api/smart-playlists", { name: "", definition: { rules: [] } })).statusCode,
      400,
    );
    const renamed = await call(kit, kit.member, "PUT", `/api/smart-playlists/${rock.id}`, {
      name: "Rock!",
      definition: { rules: [{ field: "genre", op: "is", value: "Jazz" }] },
    });
    assert.equal(renamed.json().name, "Rock!");
    assert.deepEqual(
      (await tracksOf(rock.id)).items.map((t) => t.title),
      ["Blue"],
    );
    assert.equal((await call(kit, kit.admin, "DELETE", `/api/smart-playlists/${rock.id}`)).statusCode, 404);
    assert.equal((await call(kit, kit.member, "DELETE", `/api/smart-playlists/${rock.id}`)).statusCode, 204);
    assert.equal((await call(kit, kit.member, "GET", "/api/smart-playlists")).json().items.length, 5);

    // Shuffle with a seed is stable.
    const shuffled = await create("Shuffle", { rules: [], sort: { by: "random", dir: "asc" } });
    const first = (await tracksOf(shuffled.id, "?seed=42")).items.map((t) => t.title);
    assert.deepEqual(
      (await tracksOf(shuffled.id, "?seed=42")).items.map((t) => t.title),
      first,
    );
    assert.equal((await tracksOf(shuffled.id, "?limit=2")).items.length, 2);

    const meta = (await call(kit, kit.member, "GET", "/api/smart-playlists/meta")).json();
    assert.equal(meta.coverage.tracks, 5);
    assert.equal(meta.coverage.genre, 5);
    assert.equal(meta.coverage.loudness, 3);
    assert.equal(meta.coverage.bpm, null, "audio analysis is not enabled");
    assert.deepEqual([...meta.genres].sort(), ["Jazz", "Pop", "Rock"]);

    assert.equal((await kit.app.inject({ method: "GET", url: "/api/smart-playlists" })).statusCode, 401);
  } finally {
    await kit.close();
  }
});
