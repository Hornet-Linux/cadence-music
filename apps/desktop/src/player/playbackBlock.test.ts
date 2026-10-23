import { describe, expect, it } from "vitest";
import { friendlyBlock } from "./playbackBlock";

describe("friendlyBlock", () => {
  it("explains the device limit calmly", () => {
    expect(friendlyBlock("quota_concurrent_streams", "x")).toBe("Playing on another device. Stop it there to play here.");
  });
  it("passes on the server's words for other limits", () => {
    expect(friendlyBlock("quota_daily_hours", "Daily limit reached.")).toBe("Daily limit reached.");
  });
  it("leaves other errors alone", () => {
    expect(friendlyBlock("not_found", "x")).toBeNull();
    expect(friendlyBlock(undefined, "x")).toBeNull();
  });
});
