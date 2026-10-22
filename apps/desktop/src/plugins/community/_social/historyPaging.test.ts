import { describe, expect, it } from "vitest";
import type { Play } from "@uma/shared";
import { HISTORY_PAGE, pageHistory } from "./historyPaging";

const mk = (n: number, start: number): Play[] =>
  Array.from({ length: n }, (_, i) => ({
    track: { id: `t${start - i}`, title: "x", artists: [] },
    playedAt: start - i,
  }));

/** A fake server holding `total` plays with timestamps total..1 (newest first). */
function fakeServer(total: number) {
  const calls: (number | undefined)[] = [];
  const getPage = async (before: number | undefined) => {
    calls.push(before);
    const newest = before === undefined ? total : Math.min(total, before - 1);
    const n = Math.max(0, Math.min(HISTORY_PAGE, newest));
    return mk(n, newest);
  };
  return { calls, getPage };
}

describe("pageHistory", () => {
  it("reads every page until the history runs out", async () => {
    const s = fakeServer(1200);
    const { plays, truncated } = await pageHistory(s.getPage);
    expect(plays).toHaveLength(1200);
    expect(truncated).toBe(false);
    expect(s.calls).toEqual([undefined, 701, 201]);
  });
  it("stops as soon as a page reaches back past stopBefore", async () => {
    const s = fakeServer(5000);
    const { plays } = await pageHistory(s.getPage, { stopBefore: 4100 });
    expect(plays.length).toBe(1000);
    expect(s.calls).toHaveLength(2);
  });
  it("caps what it loads and says so", async () => {
    const s = fakeServer(5000);
    const result = await pageHistory(s.getPage, { maxPlays: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.plays.length).toBe(1000);
  });
  it("copes with an empty history and a page that makes no progress", async () => {
    expect((await pageHistory(async () => [])).plays).toEqual([]);
    const stuck = await pageHistory(async () => mk(HISTORY_PAGE, 9999), { maxPlays: 100000 });
    expect(stuck.truncated).toBe(true);
    expect(stuck.plays.length).toBe(HISTORY_PAGE);
  });
});