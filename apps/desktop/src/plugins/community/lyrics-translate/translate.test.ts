import { describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import type { PluginStorage } from "../../types";
import { PersistentCache } from "../lyrics-view/cache";
import { BadAnswer, dedupeLines, makeBatches, sendWithSplit, translateCached, translateLines, translationKey } from "./translate";

const upper = vi.fn(async (lines: string[]) => lines.map((l) => l.toUpperCase()));
const track: Track = { id: "1", title: "Song", artists: [{ id: "a", name: "Artist" }] };

function memoryStorage(): PluginStorage {
  const data = new Map<string, unknown>();
  return {
    get: <T>(k: string) => (data.has(k) ? (JSON.parse(JSON.stringify(data.get(k))) as T) : null),
    set: (k, v) => void data.set(k, JSON.parse(JSON.stringify(v))),
    remove: (k) => void data.delete(k),
  };
}

describe("dedupeLines", () => {
  it("translates a repeated line once and skips blanks", () => {
    expect(dedupeLines(["la", "", "la", "oh", "  ", "la"])).toEqual({ unique: ["la", "oh"], indexOf: [0, -1, 0, 1, -1, 0] });
  });
});

describe("makeBatches", () => {
  it("splits by line count", () => {
    expect(makeBatches(["a", "b", "c", "d", "e"], { maxLines: 2, maxChars: 100 })).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });
  it("splits by size and gives a long line its own batch", () => {
    expect(makeBatches(["aaaa", "bbbb", "cccccccccc", "d"], { maxLines: 10, maxChars: 9 })).toEqual([["aaaa", "bbbb"], ["cccccccccc"], ["d"]]);
  });
  it("returns nothing for nothing", () => {
    expect(makeBatches([])).toEqual([]);
  });
});

describe("translateLines", () => {
  it("batches, restores order and leaves gaps empty", async () => {
    upper.mockClear();
    const out = await translateLines(["one", "", "two", "one", "three"], upper, { limits: { maxLines: 2, maxChars: 100 } });
    expect(out).toEqual(["ONE", "", "TWO", "ONE", "THREE"]);
    expect(upper.mock.calls.map((c) => c[0])).toEqual([["one", "two"], ["three"]]);
  });

  it("reports progress", async () => {
    const progress = vi.fn();
    await translateLines(["a", "b", "c"], upper, { limits: { maxLines: 2, maxChars: 100 }, onProgress: progress });
    expect(progress.mock.calls).toEqual([[2, 3], [3, 3]]);
  });

  it("splits a batch when the model returns the wrong number of lines", async () => {
    const calls: string[][] = [];
    const flaky = async (lines: string[]) => {
      calls.push(lines);
      return lines.length > 2 ? lines.slice(1).map((l) => l.toUpperCase()) : lines.map((l) => l.toUpperCase());
    };
    const out = await translateLines(["a", "b", "c", "d"], flaky);
    expect(out).toEqual(["A", "B", "C", "D"]);
    expect(calls).toEqual([["a", "b", "c", "d"], ["a", "b"], ["c", "d"]]);
  });

  it("falls back to the original line if a single line keeps failing", async () => {
    const out = await sendWithSplit(["x"], async () => []);
    expect(out).toEqual(["x"]);
    const bad = await sendWithSplit(["x", "y"], async (lines) => {
      if (lines.length > 1) throw new BadAnswer("shape");
      return [lines[0]!.toUpperCase()];
    });
    expect(bad).toEqual(["X", "Y"]);
  });

  it("stops on a real failure and on abort", async () => {
    await expect(translateLines(["a"], async () => Promise.reject(new Error("no key")))).rejects.toThrow("no key");
    const controller = new AbortController();
    controller.abort();
    await expect(translateLines(["a"], upper, { signal: controller.signal })).rejects.toThrow();
  });
});

describe("translateCached", () => {
  const options = { maxEntries: 5, maxBytes: 100_000, ttlMs: 60_000 };

  it("remembers a translation per track and language", async () => {
    const cache = new PersistentCache<string[]>(memoryStorage(), "t", options);
    const send = vi.fn(async (lines: string[]) => lines.map((l) => `${l}!`));
    const lines = ["hello", "", "world"];
    expect(await translateCached(cache, track, "English", lines, send)).toEqual(["hello!", "", "world!"]);
    expect(await translateCached(cache, track, "English", lines, send)).toEqual(["hello!", "", "world!"]);
    expect(send).toHaveBeenCalledTimes(1);
    await translateCached(cache, track, "French", lines, send);
    expect(send).toHaveBeenCalledTimes(2);
    await translateCached(cache, { ...track, id: "2" }, "English", lines, send);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("does not cache failures", async () => {
    const cache = new PersistentCache<string[]>(memoryStorage(), "t", options);
    await expect(translateCached(cache, track, "English", ["a"], async () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(cache.size).toBe(0);
  });

  it("keys change when the lyrics change", () => {
    expect(translationKey(track, "English", ["a", "b"])).not.toBe(translationKey(track, "English", ["a", "c"]));
    expect(translationKey(track, "English", ["a"])).toBe(translationKey(track, "english", ["a"]));
  });
});
