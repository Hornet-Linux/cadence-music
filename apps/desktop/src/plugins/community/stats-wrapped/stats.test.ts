import { describe, expect, it } from "vitest";
import type { Play } from "@uma/shared";
import { aggregate, computeStreaks, dayNumber, formatHours, headline, makeRanges, peakHour, peakWeekday, yearsWithPlays } from "./stats";

const track = (id: string, artist = "Artist A", album = "Album", durationSec: number | null = 200) => ({
  id,
  title: `Song ${id}`,
  artists: [{ id: artist, name: artist }],
  album,
  durationSec: durationSec ?? undefined,
});
// Local-time dates keep these tests independent of the machine's time zone.
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const play = (t: ReturnType<typeof track>, when: number): Play => ({ track: t, playedAt: when });

describe("streaks", () => {
  const day = (y: number, m: number, d: number) => dayNumber(at(y, m, d));
  it("finds the longest run and the one still alive", () => {
    const days = [day(2025, 3, 1), day(2025, 3, 2), day(2025, 3, 3), day(2025, 3, 10), day(2025, 3, 11)];
    expect(computeStreaks(days, day(2025, 3, 11))).toEqual({ current: 2, longest: 3, activeDays: 5 });
  });
  it("keeps a streak alive until the end of the next day, then lets it lapse", () => {
    const days = [day(2025, 3, 1), day(2025, 3, 2)];
    expect(computeStreaks(days, day(2025, 3, 3)).current).toBe(2);
    expect(computeStreaks(days, day(2025, 3, 4)).current).toBe(0);
  });
  it("counts duplicate days once and handles no data", () => {
    expect(computeStreaks([5, 5, 5], 5)).toEqual({ current: 1, longest: 1, activeDays: 1 });
    expect(computeStreaks([], 5)).toEqual({ current: 0, longest: 0, activeDays: 0 });
  });
  it("is not confused by the clocks changing", () => {
    // Late March / late October: days of 23 and 25 hours must still be consecutive.
    const days = [day(2025, 3, 29), day(2025, 3, 30), day(2025, 3, 31), day(2025, 10, 25), day(2025, 10, 26), day(2025, 10, 27)];
    expect(computeStreaks(days, day(2025, 10, 27)).longest).toBe(3);
  });
});

describe("aggregate", () => {
  const plays: Play[] = [
    play(track("1", "Artist A", "Album X"), at(2025, 1, 6, 9)), // Monday morning
    play(track("1", "Artist A", "Album X"), at(2025, 1, 6, 21)), // Monday evening, repeat
    play(track("2", "Artist B", "Album Y", 100), at(2025, 1, 7, 21)), // Tuesday evening
    play(track("3", "artist a", "Album X"), at(2025, 1, 8, 21)), // Wednesday; artist name case differs
    play(track("1", "Artist A", "Album X"), at(2024, 6, 1)), // a year before
  ];
  const range2025 = { since: at(2025, 1, 1, 0), until: at(2026, 1, 1, 0) };
  const stats = aggregate(plays, range2025, at(2025, 1, 8, 22));

  it("counts only plays inside the range", () => {
    expect(stats.plays).toBe(4);
    expect(stats.uniqueTracks).toBe(3);
  });
  it("ranks artists case-insensitively and tracks by plays", () => {
    expect(stats.topArtists[0]).toMatchObject({ name: "Artist A", plays: 3 });
    expect(stats.topArtists).toHaveLength(2);
    expect(stats.topTracks[0].track.id).toBe("1");
    expect(stats.topTracks[0].plays).toBe(2);
  });
  it("groups albums by album and artist", () => {
    expect(stats.topAlbums[0]).toMatchObject({ album: "Album X", plays: 3 });
  });
  it("estimates listening time from track lengths, with a default for unknown ones", () => {
    expect(stats.seconds).toBe(200 + 200 + 100 + 200);
    const unknown = aggregate([play(track("u", "A", "B", null), at(2025, 2, 1))], range2025, at(2025, 2, 1));
    expect(unknown.seconds).toBe(210);
  });
  it("splits listening by weekday (Monday first) and by hour", () => {
    expect(stats.secondsByWeekday[0]).toBe(400);
    expect(stats.secondsByWeekday[1]).toBe(100);
    expect(stats.secondsByWeekday[2]).toBe(200);
    expect(stats.secondsByHour[9]).toBe(200);
    expect(stats.secondsByHour[21]).toBe(500);
    expect(peakWeekday(stats.secondsByWeekday)).toBe("Mon");
    expect(peakHour(stats.secondsByHour)).toBe("9 pm");
  });
  it("finds streaks and the busiest day", () => {
    expect(stats.streaks).toEqual({ current: 3, longest: 3, activeDays: 3 });
    expect(stats.busiestDay).toEqual({ date: "2025-01-06", plays: 2 });
  });
  it("separates music new to you from repeats, using your whole history", () => {
    // Track 1 was first heard in 2024, so its 2025 plays are repeats. Tracks 2 and 3 are new.
    expect(stats.newVsRepeat).toEqual({ newPlays: 2, repeatPlays: 2, newTracks: 2, newShare: 0.5 });
  });
  it("returns zeros for an empty range", () => {
    const empty = aggregate(plays, { since: at(2030, 1, 1), until: at(2031, 1, 1) });
    expect(empty.plays).toBe(0);
    expect(empty.newVsRepeat.newShare).toBe(0);
    expect(empty.busiestDay).toBeNull();
    expect(peakHour(empty.secondsByHour)).toBeNull();
    expect(headline(empty)).toMatch(/No listening/);
  });
});

describe("ranges and formatting", () => {
  it("offers recent windows, each year with plays, and all time", () => {
    const now = new Date(2025, 5, 15, 10);
    const ranges = makeRanges(now, [2023, 2024, 2025]);
    expect(ranges.map((r) => r.id)).toEqual(["7d", "30d", "month", "y2025", "y2024", "y2023", "all"]);
    const y2024 = ranges.find((r) => r.id === "y2024")!;
    expect(y2024.since).toBe(new Date(2024, 0, 1).getTime());
    expect(y2024.until).toBe(new Date(2025, 0, 1).getTime());
    expect(ranges.find((r) => r.id === "y2025")!.label).toBe("2025 so far");
    const week = ranges[0];
    expect(week.until - week.since).toBe(7 * 86_400_000);
  });
  it("lists the years that appear in the plays", () => {
    expect(yearsWithPlays([play(track("1"), at(2022, 3, 3)), play(track("2"), at(2024, 3, 3))]).sort()).toEqual([2022, 2024]);
  });
  it("formats hours compactly", () => {
    expect(formatHours(30 * 60)).toBe("30 min");
    expect(formatHours(5400)).toBe("1.5 h");
    expect(formatHours(40 * 3600)).toBe("40 h");
  });
});