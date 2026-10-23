import { describe, expect, it, vi } from "vitest";
import { CHECK_INTERVAL_MS, dismissUpdate, isNewer, parseRelease, parseVersion, pendingUpdate, shouldCheck } from "./updateNotice";

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  } as Storage;
}
const release = (over: object = {}) => ({
  tag_name: "v0.3.0",
  html_url: "https://github.com/Hornet-Linux/cadence-music/releases/tag/v0.3.0",
  ...over,
});
const ok = (body: unknown) => vi.fn(async () => ({ ok: true, json: async () => body }) as Response);
const failing = () =>
  vi.fn(async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;

describe("version compare", () => {
  it("parses versions and rejects tags that are not versions", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("1.2.3-beta.1")).toEqual([1, 2, 3]);
    expect(parseVersion("nightly")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
  it("is newer only when strictly greater", () => {
    expect(isNewer("v0.3.0", "0.2.0")).toBe(true);
    expect(isNewer("0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("1.0", "1.0.0")).toBe(false);
    expect(isNewer("0.2.0", "0.2.0")).toBe(false);
    expect(isNewer("0.1.9", "0.2.0")).toBe(false);
    expect(isNewer("nightly", "0.2.0")).toBe(false);
    expect(isNewer("v0.3.0", "dev")).toBe(false);
  });
});

describe("shouldCheck", () => {
  it("checks at most once a day", () => {
    expect(shouldCheck(1000, 0)).toBe(true);
    expect(shouldCheck(1000 + CHECK_INTERVAL_MS - 1, 1000)).toBe(false);
    expect(shouldCheck(1000 + CHECK_INTERVAL_MS, 1000)).toBe(true);
    expect(shouldCheck(500, 1000)).toBe(true); // clock went backwards
  });
});

describe("parseRelease", () => {
  it("ignores drafts, pre-releases and junk", () => {
    expect(parseRelease(release())?.tag).toBe("v0.3.0");
    expect(parseRelease(release({ prerelease: true }))).toBeNull();
    expect(parseRelease(release({ draft: true }))).toBeNull();
    expect(parseRelease({})).toBeNull();
    expect(parseRelease(null)).toBeNull();
  });
  it("only links to github.com", () => {
    expect(parseRelease(release({ html_url: "https://evil.example/x" }))?.url).toBe(
      "https://github.com/Hornet-Linux/cadence-music/releases/latest",
    );
  });
});

describe("pendingUpdate", () => {
  it("offers a newer release, then respects dismissal", async () => {
    const store = memory();
    const fetchFn = ok(release());
    const found = await pendingUpdate({ current: "0.2.0", store, fetchFn, now: () => 1000 });
    expect(found?.tag).toBe("v0.3.0");
    dismissUpdate(store, "v0.3.0");
    expect(await pendingUpdate({ current: "0.2.0", store, fetchFn, now: () => 2000 })).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1); // the second call used the remembered answer
  });
  it("offers again for an even newer release after a dismissal", async () => {
    const store = memory();
    dismissUpdate(store, "v0.3.0");
    const f = ok(release({ tag_name: "v0.4.0" }));
    expect((await pendingUpdate({ current: "0.2.0", store, fetchFn: f, now: () => 1000 }))?.tag).toBe("v0.4.0");
  });
  it("says nothing when up to date, offline or rate limited", async () => {
    expect(await pendingUpdate({ current: "0.3.0", store: memory(), fetchFn: ok(release()), now: () => 1 })).toBeNull();
    expect(await pendingUpdate({ current: "0.2.0", store: memory(), fetchFn: failing(), now: () => 1 })).toBeNull();
    const limited = vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response);
    expect(await pendingUpdate({ current: "0.2.0", store: memory(), fetchFn: limited, now: () => 1 })).toBeNull();
  });
  it("does not hit the network again within a day, even after a failure", async () => {
    const store = memory();
    const down = failing();
    await pendingUpdate({ current: "0.2.0", store, fetchFn: down, now: () => 1000 });
    await pendingUpdate({ current: "0.2.0", store, fetchFn: down, now: () => 2000 });
    expect(down).toHaveBeenCalledTimes(1);
  });
});
