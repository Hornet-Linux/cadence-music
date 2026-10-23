import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TUNING, useTuning } from "@/player/tuning";
import type { CommandContribution } from "@/plugins/types";
import { renderLive } from "../_audio-kit/testing";
import plugin, { SleepPanel, controller, sleepPrefs } from "./index";
import { SleepController, fadeGain, formatRemaining, useSleep } from "./sleep";

interface FakePlayer {
  state: { isPlaying: boolean; position: number; duration: number };
  getState: () => { isPlaying: boolean; position: number; duration: number };
  toggle: ReturnType<typeof vi.fn>;
}

function fakePlayer(): FakePlayer {
  const p: FakePlayer = {
    state: { isPlaying: true, position: 0, duration: 200 },
    getState: () => p.state,
    toggle: vi.fn(() => {
      p.state.isPlaying = !p.state.isPlaying;
    }),
  };
  return p;
}

function makeController(player: FakePlayer, fadeSec = 20) {
  return new SleepController({ player: () => player as never, fadeSec: () => fadeSec });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T22:00:00Z"));
  useTuning.setState({ ...DEFAULT_TUNING });
  useSleep.setState({ active: null });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("fadeGain", () => {
  it("is full volume until the fade starts, then eases to silence", () => {
    expect(fadeGain(60, 20)).toBe(1);
    expect(fadeGain(20, 20)).toBe(1);
    expect(fadeGain(10, 20)).toBeCloseTo(Math.SQRT1_2);
    expect(fadeGain(0, 20)).toBeCloseTo(0);
    expect(fadeGain(-5, 20)).toBeCloseTo(0);
  });
  it("never fades when the fade length is zero", () => {
    expect(fadeGain(0.1, 0)).toBe(1);
  });
  it("only ever goes down as time runs out", () => {
    let last = 1;
    for (let r = 20; r >= 0; r -= 1) {
      const g = fadeGain(r, 20);
      expect(g).toBeLessThanOrEqual(last);
      last = g;
    }
  });
});

describe("formatRemaining", () => {
  it("formats minutes, seconds and hours", () => {
    expect(formatRemaining(61_000)).toBe("1:01");
    expect(formatRemaining(59_100)).toBe("1:00");
    expect(formatRemaining(3_725_000)).toBe("1:02:05");
    expect(formatRemaining(-10)).toBe("0:00");
  });
});

describe("minutes mode", () => {
  it("fades during the last seconds, then pauses and restores the volume", () => {
    const player = fakePlayer();
    const c = makeController(player);
    c.startMinutes(1);
    expect(useSleep.getState().active).toMatchObject({ kind: "minutes", minutes: 1 });

    vi.advanceTimersByTime(30_000);
    expect(useTuning.getState().masterGain).toBe(1);
    expect(player.toggle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(20_000); // 10 s left of a 20 s fade
    expect(useTuning.getState().masterGain).toBeCloseTo(Math.SQRT1_2, 1);

    vi.advanceTimersByTime(10_500);
    expect(player.toggle).toHaveBeenCalledTimes(1);
    expect(player.state.isPlaying).toBe(false);
    expect(useSleep.getState().active).toBeNull();
    expect(c.running).toBe(false);

    vi.advanceTimersByTime(700);
    expect(useTuning.getState().masterGain).toBe(1);
  });

  it("does not toggle playback that is already paused", () => {
    const player = fakePlayer();
    player.state.isPlaying = false;
    const c = makeController(player);
    c.startMinutes(1);
    vi.advanceTimersByTime(61_000);
    expect(player.toggle).not.toHaveBeenCalled();
    expect(useSleep.getState().active).toBeNull();
  });

  it("cancel restores the volume and stops the clock", () => {
    const player = fakePlayer();
    const c = makeController(player);
    c.startMinutes(1);
    vi.advanceTimersByTime(55_000);
    expect(useTuning.getState().masterGain).toBeLessThan(1);
    c.cancel();
    expect(useTuning.getState().masterGain).toBe(1);
    vi.advanceTimersByTime(120_000);
    expect(player.toggle).not.toHaveBeenCalled();
    expect(c.running).toBe(false);
  });

  it("clamps the length and replaces an earlier timer", () => {
    const player = fakePlayer();
    const c = makeController(player);
    c.startMinutes(99999);
    expect(useSleep.getState().active?.minutes).toBe(24 * 60);
    c.startMinutes(0);
    expect(useSleep.getState().active?.minutes).toBe(1);
  });

  it("works with no fade configured", () => {
    const player = fakePlayer();
    const c = makeController(player, 0);
    c.startMinutes(1);
    vi.advanceTimersByTime(59_000);
    expect(useTuning.getState().masterGain).toBe(1);
    vi.advanceTimersByTime(1_500);
    expect(player.toggle).toHaveBeenCalledTimes(1);
  });
});

describe("end of track mode", () => {
  it("asks the player to stop after this track and fades the last seconds", () => {
    const player = fakePlayer();
    const c = makeController(player);
    c.startEndOfTrack();
    expect(useTuning.getState().stopAfterTrack).toBe(true);
    expect(useSleep.getState().active?.kind).toBe("track");

    player.state.position = 100;
    vi.advanceTimersByTime(500);
    expect(useTuning.getState().masterGain).toBe(1);

    player.state.position = 190; // 10 s left
    vi.advanceTimersByTime(500);
    expect(useTuning.getState().masterGain).toBeCloseTo(Math.SQRT1_2, 1);
  });

  it("finishes once the player has stopped by itself", () => {
    const player = fakePlayer();
    const c = makeController(player);
    c.startEndOfTrack();
    player.state.position = 199;
    vi.advanceTimersByTime(500);
    // The player stops at the end and clears the flag.
    useTuning.getState().set({ stopAfterTrack: false });
    player.state.isPlaying = false;
    vi.advanceTimersByTime(500);
    expect(useSleep.getState().active).toBeNull();
    expect(useTuning.getState().masterGain).toBe(1);
    expect(player.toggle).not.toHaveBeenCalled();
  });

  it("cancel gives the stop request back", () => {
    const c = makeController(fakePlayer());
    c.startEndOfTrack();
    c.cancel();
    expect(useTuning.getState().stopAfterTrack).toBe(false);
  });

  it("accounts for playback speed when fading", () => {
    const player = fakePlayer();
    const c = makeController(player);
    useTuning.getState().set({ rate: 2 });
    c.startEndOfTrack();
    player.state.position = 190; // 10 media-seconds = 5 real seconds left
    vi.advanceTimersByTime(500);
    expect(useTuning.getState().masterGain).toBeCloseTo(fadeGain(5, 20), 2);
  });
});

describe("plugin", () => {
  it("registers a panel and commands, and starts timers from them", () => {
    const commands = new Map<string, CommandContribution>();
    const player = fakePlayer();
    plugin.activate({
      storage: { get: () => null, set: () => undefined, remove: () => undefined },
      player,
      registerSettingsPanel: () => undefined,
      registerCommand: (c: CommandContribution) => void commands.set(c.id, c),
    } as never);
    expect([...commands.keys()]).toEqual(["sleep-15", "sleep-30", "sleep-60", "sleep-track", "sleep-cancel"]);
    commands.get("sleep-30")!.run();
    expect(useSleep.getState().active?.minutes).toBe(30);
    expect(sleepPrefs.get().lastMinutes).toBe(30);
    commands.get("sleep-cancel")!.run();
    expect(useSleep.getState().active).toBeNull();

    commands.get("sleep-track")!.run();
    expect(useTuning.getState().stopAfterTrack).toBe(true);
    void plugin.deactivate?.();
    expect(useTuning.getState().stopAfterTrack).toBe(false);
    expect(controller.running).toBe(false);
  });

  it("shows the countdown in the panel and cancels from it", () => {
    plugin.activate({
      storage: { get: () => null, set: () => undefined, remove: () => undefined },
      player: fakePlayer(),
      registerSettingsPanel: () => undefined,
      registerCommand: () => undefined,
    } as never);
    const view = renderLive(<SleepPanel />);
    expect(view.html()).toContain("No timer is running");
    act(() => controller.startMinutes(10));
    expect(view.html()).toContain("Pausing in 10:00");
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(view.html()).toContain("Pausing in 9:57");
    const cancel = [...view.container.querySelectorAll("button")].find((b) => b.textContent === "Cancel timer")!;
    act(() => cancel.click());
    expect(view.html()).toContain("No timer is running");
    view.unmount();
  });
});
