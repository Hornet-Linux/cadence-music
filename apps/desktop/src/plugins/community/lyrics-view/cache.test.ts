import { describe, expect, it } from "vitest";
import type { PluginStorage } from "../../types";
import { PersistentCache } from "./cache";

function memoryStorage(): PluginStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(k: string) => (data.has(k) ? (JSON.parse(JSON.stringify(data.get(k))) as T) : null),
    set: (k, v) => void data.set(k, JSON.parse(JSON.stringify(v))),
    remove: (k) => void data.delete(k),
  };
}

const opts = { maxEntries: 3, maxBytes: 10_000, ttlMs: 1000, missTtlMs: 100 };

describe("PersistentCache", () => {
  it("stores values, remembers misses, and persists across instances", () => {
    const storage = memoryStorage();
    const cache = new PersistentCache<string>(storage, "c", opts);
    expect(cache.get("a")).toBeUndefined();
    cache.set("a", "one");
    cache.set("b", null);
    expect(cache.get("a")).toBe("one");
    expect(cache.get("b")).toBeNull();
    const again = new PersistentCache<string>(storage, "c", opts);
    expect(again.get("a")).toBe("one");
    expect(again.get("b")).toBeNull();
  });

  it("drops the oldest entries past the entry cap", () => {
    const cache = new PersistentCache<number>(memoryStorage(), "c", opts);
    [1, 2, 3, 4].forEach((n) => cache.set(`k${n}`, n));
    expect(cache.size).toBe(3);
    expect(cache.get("k1")).toBeUndefined();
    expect(cache.get("k4")).toBe(4);
  });

  it("rewriting a key makes it the newest", () => {
    const cache = new PersistentCache<number>(memoryStorage(), "c", opts);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("a", 10);
    cache.set("d", 4);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(10);
  });

  it("enforces the byte cap, always keeping the newest entry", () => {
    const storage = memoryStorage();
    const cache = new PersistentCache<string>(storage, "c", { ...opts, maxEntries: 50, maxBytes: 600 });
    for (let i = 0; i < 10; i++) cache.set(`k${i}`, "x".repeat(200));
    expect(JSON.stringify(storage.data.get("c")).length).toBeLessThan(900);
    expect(cache.get("k9")).toBe("x".repeat(200));
    expect(cache.get("k0")).toBeUndefined();
    cache.set("huge", "y".repeat(5000));
    expect(cache.get("huge")).toBe("y".repeat(5000));
  });

  it("expires hits and misses on their own clocks", () => {
    let now = 0;
    const cache = new PersistentCache<string>(memoryStorage(), "c", { ...opts, now: () => now });
    cache.set("hit", "v");
    cache.set("miss", null);
    now = 150;
    expect(cache.get("miss")).toBeUndefined();
    expect(cache.get("hit")).toBe("v");
    now = 1200;
    expect(cache.get("hit")).toBeUndefined();
  });

  it("survives broken stored data and a storage that throws", () => {
    const storage = memoryStorage();
    storage.set("c", { nonsense: true });
    const cache = new PersistentCache<string>(storage, "c", opts);
    expect(cache.get("a")).toBeUndefined();
    const broken: PluginStorage = {
      get: () => {
        throw new Error("no");
      },
      set: () => {
        throw new Error("full");
      },
      remove: () => undefined,
    };
    const c2 = new PersistentCache<string>(broken, "c", opts);
    c2.set("a", "v");
    expect(c2.get("a")).toBe("v");
  });

  it("clear and delete work", () => {
    const cache = new PersistentCache<string>(memoryStorage(), "c", opts);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
