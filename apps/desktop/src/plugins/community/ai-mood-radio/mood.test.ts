import { describe, expect, it, vi } from "vitest";
import type { DjTrack } from "@/features/dj/resolve";
import type { Track } from "@/shared/types";
import type { PlaybackEvent } from "../../types";
import {
  FINISH_RATIO,
  ListenTracker,
  MOODS,
  SKIP_SECONDS,
  SWITCH_COOLDOWN_MS,
  classify,
  feedbackNotes,
  moodPrompt,
  shouldSwitchUp,
  upcoming,
} from "./mood";
import { REFILL_AT, createRadioStore, type PlayerPort, type RadioDeps } from "./radio";

const t = (id: string, title = id, artist = "Artist"): Track => ({ id, title, artists: [{ id: artist, name: artist }], durationSec: 200 });
const dj = (id: string): DjTrack => ({ track: t(id), intro: `Intro for ${id}` });

/** Plays a track for `seconds` and then moves on (or ends it). */
function listen(tracker: ListenTracker, track: Track, seconds: number, end = false) {
  tracker.handle({ kind: "track", track });
  tracker.handle({ kind: "progress", track, position: seconds, duration: 200 });
  if (end) tracker.handle({ kind: "ended", track, position: 200, duration: 200 });
}

describe("moods", () => {
  it("has the five activity moods with prompts the DJ can use", () => {
    expect(MOODS.map((m) => m.id)).toEqual(["focus", "workout", "sleep", "party", "commute"]);
    expect(moodPrompt("sleep", "")).toMatch(/fall asleep/);
    expect(moodPrompt("custom", "  rainy \n night   drive ")).toBe("rainy night drive");
    expect(moodPrompt("custom", "x".repeat(500))).toHaveLength(120);
  });
});

describe("classify", () => {
  it("calls an early leave a skip, a long listen finished, and the middle partial", () => {
    expect(classify(10, 200, false)).toBe("skipped");
    expect(classify(SKIP_SECONDS - 1, 0, false)).toBe("skipped");
    expect(classify(60, 200, false)).toBe("partial");
    expect(classify(200 * FINISH_RATIO, 200, false)).toBe("finished");
    expect(classify(5, 200, true)).toBe("finished");
    // Skipping late in a short track is not a skip.
    expect(classify(35, 40, false)).toBe("finished");
  });
});

describe("ListenTracker", () => {
  const ours = new Set(["a", "b", "c", "d"]);

  it("records skips and finishes for radio tracks only", () => {
    const seen: string[] = [];
    const tracker = new ListenTracker((id) => ours.has(id), (r) => seen.push(`${r.track.id}:${r.outcome}`));
    listen(tracker, t("a"), 8); // skipped
    listen(tracker, t("b"), 190, true); // finished
    listen(tracker, t("x"), 3); // not ours
    listen(tracker, t("c"), 100); // partial
    tracker.handle({ kind: "track", track: t("d") });
    expect(seen).toEqual(["a:skipped", "b:finished", "c:partial"]);
    expect(tracker.counts()).toEqual({ skipped: 1, finished: 1 });
  });

  it("counts consecutive skips and resets on a finish or an explicit reset", () => {
    const tracker = new ListenTracker(() => true);
    listen(tracker, t("a"), 5);
    listen(tracker, t("b"), 5);
    listen(tracker, t("c"), 5);
    tracker.handle({ kind: "track", track: null });
    expect(tracker.skipStreak()).toBe(3);
    tracker.resetStreak();
    expect(tracker.skipStreak()).toBe(0);
    listen(tracker, t("e"), 5);
    listen(tracker, t("f"), 5);
    tracker.handle({ kind: "track", track: null });
    expect(tracker.skipStreak()).toBe(2);
  });

  it("ignores seeking forward as listening time, and flush closes the current song", () => {
    const tracker = new ListenTracker(() => true);
    const track = t("a");
    tracker.handle({ kind: "track", track });
    tracker.handle({ kind: "seek", track, position: 190, duration: 200 });
    tracker.flush();
    expect(tracker.reactions[0].outcome).toBe("skipped");
  });
});

describe("feedback and switching", () => {
  it("turns reactions into short prompt lines, newest few only", () => {
    const reactions = [
      ...Array.from({ length: 8 }, (_, i) => ({ track: t(`s${i}`, `Skip ${i}`), outcome: "skipped" as const })),
      { track: t("f1", "Keeper"), outcome: "finished" as const },
      { track: t("p1", "Middling"), outcome: "partial" as const },
    ];
    const notes = feedbackNotes(reactions);
    expect(notes.filter((n) => n.startsWith("Skipped"))).toHaveLength(5);
    expect(notes[0]).toContain("Skip 3");
    expect(notes.some((n) => n.includes("Keeper") && n.startsWith("Listened all the way"))).toBe(true);
    expect(notes.some((n) => n.includes("Middling"))).toBe(false);
    expect(feedbackNotes([])).toEqual([]);
  });

  it("changes direction after a streak of skips, but not twice in a row", () => {
    expect(shouldSwitchUp(2, -Infinity, 0)).toBe(false);
    expect(shouldSwitchUp(3, -Infinity, 0)).toBe(true);
    expect(shouldSwitchUp(5, 1000, 1000 + SWITCH_COOLDOWN_MS - 1)).toBe(false);
    expect(shouldSwitchUp(3, 1000, 1000 + SWITCH_COOLDOWN_MS)).toBe(true);
  });

  it("counts what is left in the queue", () => {
    expect(upcoming(10, 7)).toBe(2);
    expect(upcoming(3, 5)).toBe(0);
  });
});

describe("radio store", () => {
  function setup() {
    let queue: Track[] = [];
    let index = 0;
    const player: PlayerPort = {
      snapshot: () => ({ queue, index }),
      play: vi.fn(async (tracks) => {
        queue = tracks;
        index = 0;
      }),
      append: vi.fn((tracks) => void (queue = [...queue, ...tracks])),
      replaceUpcoming: vi.fn(async (tracks) => {
        queue = [...queue.slice(0, index + 1), ...tracks];
        index += 1;
      }),
    };
    let n = 0;
    const plan = vi.fn(async (_ref: string, _profile: unknown, opts: { history?: DjTrack[]; switchUp?: boolean }) => {
      void opts;
      return Array.from({ length: 4 }, () => dj(`t${++n}`));
    });
    let clock = 0;
    const deps: RadioDeps = {
      provider: async () => ({ ref: "server:1" }),
      profile: async () => ({ topArtists: [], genres: [], topTracks: [], recentTracks: [] }),
      plan: plan as RadioDeps["plan"],
      player,
      stopDj: vi.fn(),
      speak: vi.fn(),
      stopSpeaking: vi.fn(),
      hostStyle: () => "dry and witty",
      now: () => clock,
    };
    const store = createRadioStore(deps);
    const play = (e: PlaybackEvent) => store.getState().onPlayback(e);
    /** The player moves to queue[i]. */
    const goto = (i: number) => {
      index = i;
      play({ kind: "track", track: queue[i] });
    };
    return { store, deps, player, plan, goto, play, advance: (ms: number) => (clock += ms), queue: () => queue };
  }

  it("starts: stops the DJ, plans with the mood, style and no feedback yet, and plays the set", async () => {
    const { store, deps, player, plan } = setup();
    await store.getState().start("workout");
    expect(deps.stopDj).toHaveBeenCalled();
    expect(plan).toHaveBeenCalledTimes(1);
    const opts = plan.mock.calls[0][2];
    expect(opts).toMatchObject({ switchUp: false, count: 8, style: "dry and witty", notes: [] });
    expect((opts as { mood: string }).mood).toMatch(/workout/);
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(store.getState().status).toBe("on");
  });

  it("tops up the queue when it runs low, passing what it already played", async () => {
    const { store, player, plan, goto } = setup();
    await store.getState().start("focus");
    goto(0); // 3 left: fine
    expect(plan).toHaveBeenCalledTimes(1);
    goto(2); // 1 left: refill
    await vi.waitFor(() => expect(player.append).toHaveBeenCalledTimes(1));
    expect(plan.mock.calls[1][2].history).toHaveLength(4);
    expect(REFILL_AT).toBe(2);
  });

  it("passes skips and finishes back to the model", async () => {
    const { store, plan, goto, play, queue } = setup();
    await store.getState().start("party");
    goto(0);
    play({ kind: "progress", track: queue()[0], position: 6, duration: 200 });
    goto(1);
    play({ kind: "progress", track: queue()[1], position: 195, duration: 200 });
    goto(2); // refill happens with notes
    await vi.waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
    const notes = (plan.mock.calls[1][2] as { notes: string[] }).notes;
    expect(notes[0]).toMatch(/^Skipped quickly/);
    expect(notes.some((n) => n.startsWith("Listened all the way through"))).toBe(true);
    expect(store.getState()).toMatchObject({ skipped: 1, finished: 1 });
  });

  it("changes direction after three quick skips, replacing what is upcoming", async () => {
    const { store, player, plan, goto, play, queue } = setup();
    await store.getState().start("focus");
    for (let i = 0; i < 3; i++) {
      goto(i);
      play({ kind: "progress", track: queue()[i], position: 4, duration: 200 });
    }
    goto(3); // the third skip is recognised when the next track starts
    await vi.waitFor(() => expect(player.replaceUpcoming).toHaveBeenCalledTimes(1));
    expect(plan.mock.calls.some((c) => (c[2] as { switchUp?: boolean }).switchUp === true)).toBe(true);
    expect(store.getState().notice).toMatch(/changing direction/i);
  });

  it("stops by itself when the listener plays something else", async () => {
    const { store, deps, play } = setup();
    await store.getState().start("sleep");
    play({ kind: "track", track: t("elsewhere") });
    expect(store.getState().status).toBe("off");
    expect(store.getState().notice).toMatch(/played something else/);
    expect(deps.stopSpeaking).toHaveBeenCalled();
  });

  it("reports errors and stays off when the first set fails; a failed top-up keeps going", async () => {
    const fail = setup();
    fail.plan.mockRejectedValueOnce(new Error("Couldn't reach Ollama"));
    await fail.store.getState().start("focus");
    expect(fail.store.getState().status).toBe("off");
    expect((fail.store.getState().error as Error).message).toMatch(/Ollama/);

    const ok = setup();
    await ok.store.getState().start("focus");
    ok.plan.mockRejectedValueOnce(new Error("rate limited"));
    ok.goto(2);
    await vi.waitFor(() => expect(ok.store.getState().error).toBeTruthy());
    expect(ok.store.getState().status).toBe("on");
    expect(ok.store.getState().planning).toBe(false);
  });

  it("needs words for a custom mood, and speaks intros only when switched on", async () => {
    const { store, deps, goto } = setup();
    await store.getState().start("custom");
    expect(store.getState().status).toBe("off");
    expect((store.getState().error as Error).message).toMatch(/Describe the mood/);

    store.getState().setCustom("rainy late-night drive");
    await store.getState().start("custom");
    expect(store.getState().status).toBe("on");
    goto(0);
    expect(deps.speak).not.toHaveBeenCalled();
    store.getState().setSpoken(true);
    goto(1);
    expect(deps.speak).toHaveBeenCalledWith(expect.stringContaining("Intro for"));
  });
});
