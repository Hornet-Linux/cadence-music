import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, matchesRule, seededRandom, validateDefinition, type Definition, type SmartTrack } from "./rules.js";

const NOW = Date.UTC(2026, 5, 1);
const DAY = 86_400_000;

const t = (id: string, over: Partial<SmartTrack> = {}): SmartTrack => ({
  id,
  title: id,
  artist: "Artist",
  album: "Album",
  genre: "Rock",
  year: 2000,
  playCount: 0,
  lastPlayedAt: null,
  addedAt: NOW - 100 * DAY,
  loudness: null,
  bpm: null,
  energy: null,
  duration: 200,
  favourite: false,
  ...over,
});

const def = (over: Partial<Definition>): Definition => ({ match: "all", rules: [], sort: { by: "title", dir: "asc" }, ...over });
const ids = (r: { tracks: SmartTrack[] }) => r.tracks.map((x) => x.id);

const library = [
  t("rock90", { genre: "Rock", year: 1994, playCount: 12, lastPlayedAt: NOW - 2 * DAY, bpm: 128, loudness: -9, favourite: true }),
  t("jazz60", {
    genre: "Jazz",
    year: 1961,
    playCount: 3,
    lastPlayedAt: NOW - 400 * DAY,
    bpm: 90,
    loudness: -18,
    artist: "Miles",
  }),
  t("pop20", { genre: "Pop", year: 2021, playCount: 0, addedAt: NOW - 5 * DAY, bpm: 100, loudness: -7, energy: 0.9 }),
  t("blank", { genre: null, year: null, artist: null, album: null }),
];

test("AND combines rules, OR accepts any", () => {
  const rules = [
    { field: "genre", op: "is", value: "rock" },
    { field: "year", op: "gte", value: 2000 },
  ] as Definition["rules"];
  assert.deepEqual(ids(evaluate(library, def({ rules }), NOW)), []);
  assert.deepEqual(ids(evaluate(library, def({ rules, match: "any" }), NOW)), ["pop20", "rock90"]);
  assert.equal(evaluate(library, def({}), NOW).total, 4, "no rules: everything");
});

test("text rules are case-insensitive and treat missing values sensibly", () => {
  const run = (op: string, value: string) => ids(evaluate(library, def({ rules: [{ field: "artist", op, value }] }), NOW));
  assert.deepEqual(run("is", "MILES"), ["jazz60"]);
  assert.deepEqual(run("contains", "ile"), ["jazz60"]);
  assert.deepEqual(run("isNot", "Artist"), ["blank", "jazz60"], "an unknown artist is not Artist");
  assert.deepEqual(run("notContains", "art"), ["blank", "jazz60"]);
});

test("number rules: comparisons, between, and unknown values", () => {
  const run = (field: string, op: string, value: number | [number, number]) =>
    ids(evaluate(library, def({ rules: [{ field, op, value } as Definition["rules"][number]] }), NOW));
  assert.deepEqual(run("bpm", "between", [95, 130]), ["pop20", "rock90"]);
  assert.deepEqual(run("bpm", "gt", 100), ["rock90"]);
  assert.deepEqual(run("loudness", "lt", -10), ["jazz60"]);
  assert.deepEqual(run("year", "lte", 1994), ["jazz60", "rock90"]);
  assert.deepEqual(run("playCount", "eq", 0), ["blank", "pop20"]);
  assert.deepEqual(run("energy", "neq", 0.9), ["blank", "jazz60", "rock90"], "unanalysed tracks are not 0.9");
  assert.deepEqual(run("energy", "gte", 0), ["pop20"], "unanalysed tracks never match a comparison");
});

test("date rules: played in the last N days, not played recently, never played, recently added", () => {
  const run = (field: string, op: string, value?: number) =>
    ids(
      evaluate(
        library,
        def({ rules: [{ field, op, ...(value === undefined ? {} : { value }) } as Definition["rules"][number]] }),
        NOW,
      ),
    );
  assert.deepEqual(run("lastPlayed", "inLast", 7), ["rock90"]);
  assert.deepEqual(run("lastPlayed", "notInLast", 30), ["blank", "jazz60", "pop20"], "never played counts as not played lately");
  assert.deepEqual(run("lastPlayed", "never"), ["blank", "pop20"]);
  assert.deepEqual(run("addedAt", "inLast", 30), ["pop20"]);
});

test("favourites rule", () => {
  assert.deepEqual(ids(evaluate(library, def({ rules: [{ field: "favourite", op: "is", value: true }] }), NOW)), ["rock90"]);
  assert.deepEqual(ids(evaluate(library, def({ rules: [{ field: "favourite", op: "is", value: false }] }), NOW)), [
    "blank",
    "jazz60",
    "pop20",
  ]);
});

test("sorting puts unknown values last in either direction; limit applies after sorting", () => {
  assert.deepEqual(ids(evaluate(library, def({ sort: { by: "bpm", dir: "asc" } }), NOW)), ["jazz60", "pop20", "rock90", "blank"]);
  assert.deepEqual(ids(evaluate(library, def({ sort: { by: "bpm", dir: "desc" } }), NOW)), [
    "rock90",
    "pop20",
    "jazz60",
    "blank",
  ]);
  const top2 = evaluate(library, def({ sort: { by: "playCount", dir: "desc" }, limit: 2 }), NOW);
  assert.deepEqual(ids(top2), ["rock90", "jazz60"]);
  assert.equal(top2.total, 4, "total counts matches before the limit");
});

test("random order is a permutation and repeatable with the same seed", () => {
  const many = Array.from({ length: 50 }, (_, i) => t(`t${i}`));
  const a = ids(evaluate(many, def({ sort: { by: "random", dir: "asc" } }), NOW, seededRandom(7)));
  const b = ids(evaluate(many, def({ sort: { by: "random", dir: "asc" } }), NOW, seededRandom(7)));
  const c = ids(evaluate(many, def({ sort: { by: "random", dir: "asc" } }), NOW, seededRandom(8)));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.deepEqual([...a].sort(), many.map((x) => x.id).sort());
});

test("matchesRule handles a rule on each field type", () => {
  assert.equal(matchesRule(library[0]!, { field: "title", op: "contains", value: "ROCK" }, NOW), true);
  assert.equal(matchesRule(library[0]!, { field: "genre", op: "is", value: "jazz" }, NOW), false);
});

test("validation accepts good definitions and cleans them", () => {
  const ok = validateDefinition({
    match: "any",
    rules: [
      { field: "genre", op: "is", value: "  Rock " },
      { field: "year", op: "between", value: [2010, 2000] },
    ],
    limit: 50,
    sort: { by: "playCount", dir: "desc" },
    junk: 1,
  });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.deepEqual(ok.definition, {
      match: "any",
      rules: [
        { field: "genre", op: "is", value: "Rock" },
        { field: "year", op: "between", value: [2000, 2010] },
      ],
      limit: 50,
      sort: { by: "playCount", dir: "desc" },
    });
  }
  const minimal = validateDefinition({ rules: [] });
  assert.ok(minimal.ok && minimal.definition.sort.by === "title" && minimal.definition.match === "all");
});

test("validation rejects nonsense", () => {
  const bad = (raw: unknown) => {
    const r = validateDefinition(raw);
    return r.ok ? "ok" : r.error;
  };
  assert.equal(bad(null), "definition_required");
  assert.equal(bad({ rules: "x" }), "rules_required");
  assert.equal(bad({ match: "some", rules: [] }), "invalid_match");
  assert.equal(bad({ rules: [{ field: "password", op: "is", value: "x" }] }), "unknown_field");
  assert.equal(bad({ rules: [{ field: "year", op: "contains", value: "x" }] }), "invalid_operator");
  assert.equal(bad({ rules: [{ field: "year", op: "gt", value: "2000" }] }), "invalid_value");
  assert.equal(bad({ rules: [{ field: "genre", op: "is", value: "" }] }), "invalid_value");
  assert.equal(bad({ rules: [{ field: "genre", op: "is", value: "x".repeat(201) }] }), "invalid_value");
  assert.equal(bad({ rules: [{ field: "lastPlayed", op: "inLast", value: -1 }] }), "invalid_value");
  assert.equal(bad({ rules: [{ field: "year", op: "between", value: [1] }] }), "invalid_value");
  assert.equal(bad({ rules: [{ field: "favourite", op: "is", value: "yes" }] }), "invalid_value");
  assert.equal(bad({ rules: [], limit: 0 }), "invalid_limit");
  assert.equal(bad({ rules: [], limit: 99999 }), "invalid_limit");
  assert.equal(bad({ rules: [], sort: { by: "rm -rf" } }), "invalid_sort");
  assert.equal(bad({ rules: Array.from({ length: 21 }, () => ({ field: "year", op: "gt", value: 1 })) }), "too_many_rules");
});
