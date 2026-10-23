import { describe, expect, it } from "vitest";
import {
  changeField,
  changeOp,
  describeDefinition,
  emptyDraft,
  fromDefinition,
  incompleteRules,
  missingData,
  newRule,
  TEMPLATES,
  toDefinition,
  toRule,
  type Definition,
} from "./model";

describe("smart playlist model", () => {
  it("builds API rules from what was typed, and leaves out incomplete ones", () => {
    const text = { ...newRule("genre"), op: "is", a: "  Rock " };
    expect(toRule(text)).toEqual({ field: "genre", op: "is", value: "Rock" });
    expect(toRule(newRule("genre"))).toBeNull();

    const between = { ...newRule("year"), op: "between", a: "2010", b: "2000" };
    expect(toRule(between)).toEqual({ field: "year", op: "between", value: [2000, 2010] });
    expect(toRule({ ...between, b: "" })).toBeNull();

    expect(toRule({ ...newRule("bpm"), op: "gte", a: "120" })).toEqual({ field: "bpm", op: "gte", value: 120 });
    expect(toRule({ ...newRule("bpm"), op: "gte", a: "fast" })).toBeNull();
    expect(toRule({ ...newRule("lastPlayed"), op: "never" })).toEqual({ field: "lastPlayed", op: "never" });
    expect(toRule({ ...newRule("lastPlayed"), op: "inLast", a: "-3" })).toBeNull();
    expect(toRule({ ...newRule("favourite"), a: "false" })).toEqual({ field: "favourite", op: "is", value: false });
  });

  it("changing the field keeps compatible rules and resets the others", () => {
    const rule = { ...newRule("artist"), op: "contains", a: "miles" };
    expect(changeField(rule, "album")).toMatchObject({ field: "album", op: "contains", a: "miles", key: rule.key });
    const reset = changeField(rule, "year");
    expect(reset).toMatchObject({ field: "year", op: "eq", a: "", key: rule.key });
    expect(changeField(reset, "favourite")).toMatchObject({ field: "favourite", op: "is", a: "true" });
    expect(changeOp({ ...reset, b: "5" }, "gt").b).toBe("");
  });

  it("round-trips a definition through the editor", () => {
    const def: Definition = {
      match: "any",
      rules: [
        { field: "genre", op: "is", value: "Jazz" },
        { field: "year", op: "between", value: [1950, 1969] },
        { field: "lastPlayed", op: "never" },
        { field: "favourite", op: "is", value: true },
      ],
      limit: 40,
      sort: { by: "year", dir: "desc" },
    };
    expect(toDefinition(fromDefinition("Mine", def))).toEqual(def);
  });

  it("limits are whole numbers from 1 to 5000, or absent", () => {
    const d = emptyDraft();
    expect(toDefinition({ ...d, limit: "" }).limit).toBeUndefined();
    expect(toDefinition({ ...d, limit: "0" }).limit).toBeUndefined();
    expect(toDefinition({ ...d, limit: "2.5" }).limit).toBeUndefined();
    expect(toDefinition({ ...d, limit: "99999" }).limit).toBe(5000);
    expect(toDefinition({ ...d, limit: "25" }).limit).toBe(25);
  });

  it("counts incomplete rules", () => {
    const d = emptyDraft();
    expect(incompleteRules(d)).toBe(1);
    expect(incompleteRules({ ...d, rules: [{ ...d.rules[0]!, a: "Rock" }] })).toBe(0);
  });

  it("describes playlists in plain words", () => {
    expect(describeDefinition({ match: "all", rules: [], sort: { by: "random", dir: "asc" } })).toBe("Every song, shuffled");
    const text = describeDefinition({
      match: "all",
      rules: [
        { field: "genre", op: "is", value: "Rock" },
        { field: "bpm", op: "between", value: [120, 140] },
        { field: "lastPlayed", op: "notInLast", value: 30 },
      ],
      limit: 50,
      sort: { by: "playCount", dir: "desc" },
    });
    expect(text).toBe(
      "genre is Rock and tempo between 120 and 140 BPM and last played not in the last 30 days, by times played (descending), first 50",
    );
  });

  it("every template is a complete, valid definition", () => {
    for (const t of TEMPLATES) {
      const draft = fromDefinition(t.name, t.definition);
      expect(incompleteRules(draft)).toBe(0);
      expect(toDefinition(draft)).toEqual(t.definition);
    }
  });

  it("warns about rules that need data the server does not have", () => {
    const draft = { ...emptyDraft(), rules: [newRule("bpm"), newRule("loudness"), newRule("genre")] };
    const none = { loudness: null, bpm: null, energy: null, genre: 0, year: 0 };
    expect(missingData(draft, none)).toHaveLength(3);
    expect(missingData(draft, { loudness: 10, bpm: 10, energy: 10, genre: 10, year: 10 })).toEqual([]);
    expect(missingData(draft, null)).toEqual([]);
  });
});
