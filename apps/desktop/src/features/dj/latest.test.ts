import { describe, expect, it } from "vitest";
import { latestOnly } from "./latest";

describe("latestOnly", () => {
  it("only the newest check counts, even if an older one finishes last", () => {
    const latest = latestOnly();
    const first = latest.begin();
    const second = latest.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("cancel makes running checks stale", () => {
    const latest = latestOnly();
    const running = latest.begin();
    latest.cancel();
    expect(running()).toBe(false);
    expect(latest.begin()()).toBe(true);
  });
});
