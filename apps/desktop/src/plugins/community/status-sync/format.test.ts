import { describe, expect, it } from "vitest";
import type { Track } from "@/shared/types";
import { DEFAULT_STATUS_SETTINGS, PRIVATE_TEXT, formatStatusText, isValidEmoji, planStatus, samePlan, type StatusSettings } from "./format";

const track: Track = {
  id: "t",
  title: "Teardrop",
  artists: [{ id: "a", name: "Massive Attack" }],
  album: "Mezzanine",
  durationSec: 330,
};
const on: StatusSettings = { ...DEFAULT_STATUS_SETTINGS, enabled: true };
const NOW = 1_800_000_000_000;

describe("formatStatusText", () => {
  it("fills the placeholders", () => {
    expect(formatStatusText("{title} - {artist}", track, false)).toBe("Teardrop - Massive Attack");
    expect(formatStatusText("{artist}: {title} ({album})", track, false)).toBe("Massive Attack: Teardrop (Mezzanine)");
  });
  it("is case-insensitive about placeholders and falls back to the default template when blank", () => {
    expect(formatStatusText("{TITLE}", track, false)).toBe("Teardrop");
    expect(formatStatusText("   ", track, false)).toBe("Teardrop - Massive Attack");
  });
  it("tidies dangling separators when a field is empty", () => {
    expect(formatStatusText("{title} - {artist}", { ...track, artists: [] }, false)).toBe("Teardrop");
    expect(formatStatusText("{album} - {title}", { ...track, album: undefined }, false)).toBe("Teardrop");
  });
  it("cuts to Slack's 100 character limit", () => {
    const long = formatStatusText("{title}", { ...track, title: "x".repeat(300) }, false);
    expect(long.length).toBe(100);
    expect(long.endsWith("\u2026")).toBe(true);
  });
  it("shares only that you are listening when the title is hidden", () => {
    expect(formatStatusText("{title}", track, true)).toBe(PRIVATE_TEXT);
  });
});

describe("emoji", () => {
  it("accepts Slack shortcodes only", () => {
    expect(isValidEmoji(":headphones:")).toBe(true);
    expect(isValidEmoji(":+1:")).toBe(true);
    expect(isValidEmoji("headphones")).toBe(false);
    expect(isValidEmoji(":has space:")).toBe(false);
    expect(isValidEmoji("")).toBe(false);
  });
});

describe("planStatus", () => {
  it("does nothing until the person opts in", () => {
    expect(planStatus(track, { isPlaying: true, position: 0, duration: 330 }, DEFAULT_STATUS_SETTINGS, NOW)).toEqual({ action: "clear" });
  });
  it("sets the status with an expiry shortly after the song should end", () => {
    const plan = planStatus(track, { isPlaying: true, position: 30, duration: 330 }, on, NOW);
    expect(plan).toEqual({ action: "set", text: "Teardrop - Massive Attack", emoji: ":headphones:", expiration: NOW / 1000 + 300 + 60 });
  });
  it("clears on pause by default, or keeps a short-lived status when asked", () => {
    const paused = { isPlaying: false, position: 30, duration: 330 };
    expect(planStatus(track, paused, on, NOW)).toEqual({ action: "clear" });
    const keep = planStatus(track, paused, { ...on, clearOnPause: false }, NOW);
    expect(keep).toMatchObject({ action: "set", expiration: NOW / 1000 + 600 + 60 });
  });
  it("clears when nothing is playing", () => {
    expect(planStatus(null, { isPlaying: true, position: 0, duration: 0 }, on, NOW)).toEqual({ action: "clear" });
  });
  it("never lets a status outlive a day, and uses a default length when the duration is unknown", () => {
    const unknown = planStatus({ ...track, durationSec: undefined }, { isPlaying: true, position: 0, duration: 0 }, on, NOW);
    expect(unknown).toMatchObject({ expiration: NOW / 1000 + 660 });
    const huge = planStatus(track, { isPlaying: true, position: 0, duration: 10 * 86_400 }, on, NOW);
    expect(huge).toMatchObject({ expiration: NOW / 1000 + 23 * 3600 });
  });
  it("replaces a bad emoji with the default", () => {
    const plan = planStatus(track, { isPlaying: true, position: 0, duration: 100 }, { ...on, emoji: "oops" }, NOW);
    expect(plan).toMatchObject({ emoji: ":headphones:" });
  });
});

describe("samePlan", () => {
  it("ignores the expiry and compares what people see", () => {
    const a = { action: "set", text: "A", emoji: ":x:", expiration: 1 } as const;
    expect(samePlan(a, { ...a, expiration: 99 })).toBe(true);
    expect(samePlan(a, { ...a, text: "B" })).toBe(false);
    expect(samePlan({ action: "clear" }, { action: "clear" })).toBe(true);
    expect(samePlan(a, { action: "clear" })).toBe(false);
    expect(samePlan(null, { action: "clear" })).toBe(false);
  });
});