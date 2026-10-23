import { describe, expect, it } from "vitest";
import type { Play } from "@uma/shared";
import { collectOnThisDay, dayWindow, describeEntry, groupByYear } from "./onThisDay";

const t = (id: string) => ({ id, title: `Song ${id}`, artists: [{ id: "a", name: "A" }] });
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const play = (id: string, when: number): Play => ({ track: t(id), playedAt: when });

describe("dayWindow", () => {
  it("covers the same calendar day in an earlier year", () => {
    const w = dayWindow(new Date(2026, 9, 22, 15), 1);
    expect(w.year).toBe(2025);
    expect(w.dayStart).toBe(at(2025, 10, 22, 0));
    expect(w.dayEnd).toBe(at(2025, 10, 23, 0));
    expect(w.since).toBe(at(2025, 10, 19, 0));
    expect(w.until).toBe(at(2025, 10, 26, 0));
  });
  it("uses 28 February for 29 February in a year without one", () => {
    const w = dayWindow(new Date(2028, 1, 29), 1);
    expect(w.dayStart).toBe(at(2027, 2, 28, 0));
    expect(dayWindow(new Date(2028, 1, 29), 4).dayStart).toBe(at(2024, 2, 29, 0));
  });
});

describe("groupByYear", () => {
  const now = new Date(2026, 9, 22, 9);
  it("prefers the exact day and orders by years ago", () => {
    const plays = [
      play("a", at(2025, 10, 22, 8)),
      play("a", at(2025, 10, 22, 20)),
      play("b", at(2025, 10, 22, 21)),
      play("near", at(2025, 10, 20)), // a neighbour day, ignored because the exact day has plays
      play("old", at(2023, 10, 22)),
      play("today", at(2026, 10, 22)), // this year is not "a year ago"
    ];
    const entries = groupByYear(plays, now);
    expect(entries.map((e) => [e.yearsAgo, e.exact, e.tracks.map((x) => x.track.id)])).toEqual([
      [1, true, ["a", "b"]],
      [3, true, ["old"]],
    ]);
    expect(entries[0].tracks[0].plays).toBe(2);
  });
  it("falls back to the days around it, and skips years with nothing", () => {
    const entries = groupByYear([play("n", at(2024, 10, 24))], now);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ yearsAgo: 2, exact: false });
    expect(describeEntry(entries[0])).toBe("Around this time in 2024");
  });
  it("returns nothing for no history", () => {
    expect(groupByYear([], now)).toEqual([]);
  });
  it("describes exact days naturally", () => {
    expect(describeEntry({ year: 2025, yearsAgo: 1, exact: true })).toBe("A year ago today (2025)");
    expect(describeEntry({ year: 2023, yearsAgo: 3, exact: true })).toBe("3 years ago today (2023)");
  });
});

describe("collectOnThisDay", () => {
  it("asks once per year and stops when there is no older history", async () => {
    const history: Play[] = [play("x", at(2025, 10, 22)), play("y", at(2024, 10, 21)), play("z", at(2022, 3, 3))].sort((a, b) => b.playedAt - a.playedAt);
    const asked: number[] = [];
    const getPage = async (before: number) => {
      asked.push(before);
      return history.filter((p) => p.playedAt < before).slice(0, 500);
    };
    const entries = await collectOnThisDay(getPage, new Date(2026, 9, 22), 10);
    expect(entries.map((e) => e.yearsAgo)).toEqual([1, 2]);
    // 2025, 2024, 2023, 2022 windows still have older history (the 2022 play); 2021 does not.
    expect(asked).toHaveLength(5);
  });
});