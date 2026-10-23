import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TUNING, useTuning } from "@/player/tuning";
import { useCollection } from "@/features/collection/collectionStore";
import type { Track } from "@/shared/types";
import { renderLive } from "../_audio-kit/testing";
import {
  GRACE_MS,
  checkAlarm,
  describeDays,
  describeNext,
  latestOccurrence,
  newAlarm,
  nextOccurrence,
  parseTime,
  rampGain,
  sanitizeAlarm,
  type Alarm,
} from "./alarm";
import { AlarmScheduler, ringAlarm, shuffled } from "./scheduler";
import plugin, { AlarmPanel, alarmPrefs, scheduler, tracksFor, useAlarmStatus } from "./index";

const track = (id: string): Track => ({ id, title: id, artists: [{ id: "a", name: "A" }] });

// Local-time helpers: 2026-03-02 is a Monday.
const at = (day: number, h: number, m = 0, s = 0) => new Date(2026, 2, day, h, m, s);
const alarm = (over: Partial<Alarm> = {}): Alarm => ({
  ...newAlarm(at(1, 0).getTime(), "a1"),
  time: "07:00",
  days: [],
  ...over,
});

describe("parseTime", () => {
  it("accepts HH:MM only", () => {
    expect(parseTime("07:30")).toEqual({ h: 7, m: 30 });
    expect(parseTime("7:05")).toEqual({ h: 7, m: 5 });
    expect(parseTime("24:00")).toBeNull();
    expect(parseTime("12:60")).toBeNull();
    expect(parseTime("noon")).toBeNull();
  });
});

describe("nextOccurrence", () => {
  it("rings later today if the time is still ahead, otherwise tomorrow", () => {
    expect(nextOccurrence(alarm(), at(2, 6, 0))).toEqual(at(2, 7, 0));
    expect(nextOccurrence(alarm(), at(2, 7, 0))).toEqual(at(3, 7, 0));
    expect(nextOccurrence(alarm(), at(2, 9, 0))).toEqual(at(3, 7, 0));
  });
  it("skips days that are not selected", () => {
    const weekdays = alarm({ days: [1, 2, 3, 4, 5] });
    // Friday 6 March after 07:00 -> Monday 9 March.
    expect(nextOccurrence(weekdays, at(6, 8, 0))).toEqual(at(9, 7, 0));
    const sundays = alarm({ days: [0] });
    expect(nextOccurrence(sundays, at(2, 8, 0))).toEqual(at(8, 7, 0));
  });
  it("is null when off or invalid", () => {
    expect(nextOccurrence(alarm({ enabled: false }), at(2, 6))).toBeNull();
    expect(nextOccurrence(alarm({ time: "bad" }), at(2, 6))).toBeNull();
  });
  it("works across midnight and month ends", () => {
    expect(nextOccurrence(alarm({ time: "00:30" }), at(31, 23, 50))).toEqual(new Date(2026, 3, 1, 0, 30));
  });
});

describe("latestOccurrence", () => {
  it("finds today's or the previous matching day's time", () => {
    expect(latestOccurrence(alarm(), at(2, 7, 0, 5))).toEqual(at(2, 7, 0));
    expect(latestOccurrence(alarm(), at(2, 6, 0))).toEqual(at(1, 7, 0));
    expect(latestOccurrence(alarm({ days: [5] }), at(2, 8))).toEqual(new Date(2026, 1, 27, 7, 0));
  });
});

describe("checkAlarm", () => {
  it("rings once when the time arrives", () => {
    const a = alarm({ armedAt: at(2, 6, 0).getTime() });
    expect(checkAlarm(a, at(2, 6, 59, 59)).kind).toBe("none");
    expect(checkAlarm(a, at(2, 7, 0, 1))).toEqual({ kind: "ring", at: at(2, 7, 0).getTime() });
    // After it was handled it stays quiet for the rest of the day.
    expect(checkAlarm({ ...a, handledAt: at(2, 7, 0).getTime() }, at(2, 7, 0, 10)).kind).toBe("none");
  });

  it("ignores occurrences before the alarm was set", () => {
    const a = alarm({ armedAt: at(2, 8, 0).getTime() });
    expect(checkAlarm(a, at(2, 8, 5)).kind).toBe("none");
    expect(checkAlarm(a, at(3, 7, 0, 2)).kind).toBe("ring");
  });

  it("reports an alarm as missed when the page was asleep past the grace period", () => {
    const a = alarm({ armedAt: at(1, 22, 0).getTime() });
    const late = new Date(at(2, 7, 0).getTime() + GRACE_MS + 60_000);
    expect(checkAlarm(a, late)).toEqual({ kind: "missed", at: at(2, 7, 0).getTime() });
    // Still rings if the page woke up a little late.
    expect(checkAlarm(a, new Date(at(2, 7, 0).getTime() + 5 * 60_000)).kind).toBe("ring");
  });

  it("plays the fallback music instead of staying silent when the source is empty", async () => {
    vi.useRealTimers();
    const player = { playTracks: vi.fn(async () => undefined), getState: () => ({ isPlaying: true }) } as never;
    const result = await ringAlarm(alarm({ rampSec: 0, shuffle: false }), { player, tracksFor: () => [], fallback: () => [track("q")], verifyAfterMs: 1 });
    expect(result).toEqual({ ok: true, started: 1, usedFallback: true });
  });

  it("does nothing for a disabled alarm", () => {
    expect(checkAlarm(alarm({ enabled: false, armedAt: 0 }), at(2, 7, 0, 1)).kind).toBe("none");
  });
});

describe("rampGain", () => {
  it("starts quiet, rises smoothly and ends at full volume", () => {
    expect(rampGain(0, 30)).toBeCloseTo(0.05);
    expect(rampGain(15, 30)).toBeGreaterThan(rampGain(5, 30));
    expect(rampGain(30, 30)).toBe(1);
    expect(rampGain(99, 30)).toBe(1);
    expect(rampGain(0, 0)).toBe(1);
  });
});

describe("labels", () => {
  it("describes days and the next ring", () => {
    expect(describeDays([])).toBe("Once");
    expect(describeDays([1, 2, 3, 4, 5])).toBe("Weekdays");
    expect(describeDays([0, 6])).toBe("Weekends");
    expect(describeDays([0, 1, 2, 3, 4, 5, 6])).toBe("Every day");
    expect(describeDays([1, 3])).toBe("Mon, Wed");
    expect(describeNext(at(3, 7, 0), at(2, 22, 0))).toBe("Rings in 9 h 0 min (Tue 07:00)");
    expect(describeNext(at(2, 7, 0), at(2, 6, 40))).toBe("Rings in 20 min (Mon 07:00)");
    expect(describeNext(null, at(2, 6))).toBe("Off");
  });
});

describe("sanitizeAlarm", () => {
  it("repairs bad stored data", () => {
    expect(sanitizeAlarm(null, "x")).toBeNull();
    const a = sanitizeAlarm({ time: "99:99", days: [1, 1, 9, 3] as number[], rampSec: 9999, source: { kind: "playlist", id: 5 as never } }, "x")!;
    expect(a.id).toBe("x");
    expect(a.time).toBe("07:00");
    expect(a.days).toEqual([1, 3]);
    expect(a.rampSec).toBe(300);
    expect(a.source).toEqual({ kind: "liked" });
    expect(sanitizeAlarm({ time: "6:05" }, "y")!.time).toBe("06:05");
  });
});

describe("AlarmScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rings due alarms once, switches one-time alarms off and reports missed ones", () => {
    let now = at(2, 6, 59, 50);
    const alarms: Alarm[] = [
      alarm({ id: "once", armedAt: at(2, 6).getTime() }),
      alarm({ id: "daily", days: [0, 1, 2, 3, 4, 5, 6], time: "07:00", armedAt: at(2, 6).getTime() }),
      alarm({ id: "old", time: "03:00", armedAt: at(1, 12).getTime() }),
    ];
    const rang: string[] = [];
    const missed: string[] = [];
    const s = new AlarmScheduler({
      now: () => now,
      alarms: () => alarms,
      update: (id, patch) => Object.assign(alarms.find((a) => a.id === id)!, patch),
      ring: (a) => rang.push(a.id),
      missed: (a) => missed.push(a.id),
    });
    s.start();
    // 03:00 today is more than the grace period ago -> missed (and one-time is switched off).
    expect(missed).toEqual(["old"]);
    expect(alarms.find((a) => a.id === "old")!.enabled).toBe(false);

    now = at(2, 7, 0, 3);
    vi.advanceTimersByTime(5000);
    expect(rang.sort()).toEqual(["daily", "once"]);
    expect(alarms.find((a) => a.id === "once")!.enabled).toBe(false);
    expect(alarms.find((a) => a.id === "daily")!.enabled).toBe(true);

    vi.advanceTimersByTime(60_000);
    expect(rang).toHaveLength(2);
    s.stop();
    expect(s.running).toBe(false);
  });

  it("checks straight away when the page becomes visible again", () => {
    let now = at(2, 6, 0);
    const a = alarm({ armedAt: at(2, 5).getTime() });
    const rang: string[] = [];
    const s = new AlarmScheduler({
      now: () => now,
      alarms: () => [a],
      update: (_id, patch) => Object.assign(a, patch),
      ring: (x) => rang.push(x.id),
      missed: () => undefined,
    });
    s.start();
    now = at(2, 7, 0, 30);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(rang).toEqual(["a1"]);
    s.stop();
  });
});

describe("ringAlarm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useTuning.setState({ ...DEFAULT_TUNING });
  });
  afterEach(() => vi.useRealTimers());

  const players = (isPlaying: boolean) => {
    const playTracks = vi.fn(async () => undefined);
    return { playTracks, getState: () => ({ isPlaying }) as never };
  };

  it("plays the tracks, starting quietly and ramping up", async () => {
    const player = players(true);
    const a = alarm({ shuffle: false, rampSec: 10 });
    const promise = ringAlarm(a, { player, tracksFor: () => [track("1"), track("2")], verifyAfterMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    expect(player.playTracks).toHaveBeenCalledWith([track("1"), track("2")], 0);
    expect(useTuning.getState().masterGain).toBeCloseTo(0.05);
    await vi.advanceTimersByTimeAsync(5500);
    expect(useTuning.getState().masterGain).toBeGreaterThan(0.2);
    await vi.advanceTimersByTimeAsync(6000);
    await expect(promise).resolves.toEqual({ ok: true, started: 2 });
    expect(useTuning.getState().masterGain).toBe(1);
  });

  it("reports an empty source", async () => {
    const player = players(true);
    await expect(ringAlarm(alarm(), { player, tracksFor: () => [] })).resolves.toEqual({ ok: false, reason: "empty" });
    expect(player.playTracks).not.toHaveBeenCalled();
  });

  it("notices when the browser blocked playback and restores the volume", async () => {
    const player = players(false);
    const promise = ringAlarm(alarm({ rampSec: 20 }), { player, tracksFor: () => [track("1")], verifyAfterMs: 50 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toEqual({ ok: false, reason: "blocked" });
    expect(useTuning.getState().masterGain).toBe(1);
  });

  it("reports errors from the player", async () => {
    const player = { playTracks: vi.fn(async () => Promise.reject(new Error("offline"))), getState: () => ({ isPlaying: false }) as never };
    await expect(ringAlarm(alarm({ rampSec: 0 }), { player, tracksFor: () => [track("1")] })).resolves.toEqual({ ok: false, reason: "error" });
  });

  it("shuffles with the supplied random source", () => {
    expect(shuffled([1, 2, 3, 4], () => 0)).toEqual([2, 3, 4, 1]);
    expect(shuffled([1, 2, 3], () => 0.99)).toEqual([1, 2, 3]);
  });
});

describe("alarm plugin", () => {
  beforeEach(() => {
    useCollection.setState({
      likes: [
        { track: track("old"), likedAt: 1 },
        { track: track("new"), likedAt: 2 },
      ],
      playlists: [{ id: "p1", name: "Morning", tracks: [track("m1"), track("m2")], updatedAt: 0 }],
    });
  });

  it("picks tracks from liked songs (newest first), a playlist or the queue", () => {
    expect(tracksFor(alarm({ source: { kind: "liked" } })).map((t) => t.id)).toEqual(["new", "old"]);
    expect(tracksFor(alarm({ source: { kind: "playlist", id: "p1" } })).map((t) => t.id)).toEqual(["m1", "m2"]);
    expect(tracksFor(alarm({ source: { kind: "playlist", id: "gone" } }))).toEqual([]);
  });

  it("asks only for the capabilities it uses, starts the scheduler and stops it on deactivate", () => {
    expect(plugin.manifest.capabilities.sort()).toEqual(["commands", "player.queue", "player.read", "storage", "ui.settings"]);
    const q = [track("q1")];
    plugin.activate({
      storage: { get: () => null, set: () => undefined, remove: () => undefined },
      player: { getState: () => ({ queue: q, isPlaying: false }), playTracks: vi.fn() },
      registerSettingsPanel: () => undefined,
      registerCommand: () => undefined,
    } as never);
    expect(scheduler.running).toBe(true);
    expect(tracksFor(alarm({ source: { kind: "queue" } }))).toEqual(q);
    void plugin.deactivate?.();
    expect(scheduler.running).toBe(false);
  });

  it("shows the phone warning, lets you add, edit and delete an alarm", () => {
    alarmPrefs.set({ alarms: [] });
    const view = renderLive(<AlarmPanel />);
    expect(view.html()).toContain("suspend web pages");
    expect(view.html()).toContain("No alarms yet");

    const add = [...view.container.querySelectorAll("button")].find((b) => b.textContent === "Add alarm")!;
    act(() => add.click());
    expect(alarmPrefs.get().alarms).toHaveLength(1);
    expect(view.html()).toContain("Weekdays");

    const day = [...view.container.querySelectorAll<HTMLButtonElement>(".alarm-days button")].find((b) => b.textContent === "Sa")!;
    act(() => day.click());
    expect(alarmPrefs.get().alarms[0].days).toEqual([1, 2, 3, 4, 5, 6]);

    act(() => useAlarmStatus.setState({ message: "Ringing: 07:00" }));
    expect(view.html()).toContain("Ringing: 07:00");

    const del = [...view.container.querySelectorAll("button")].find((b) => b.textContent === "Delete alarm")!;
    act(() => del.click());
    expect(alarmPrefs.get().alarms).toHaveLength(0);
    view.unmount();
  });
});
