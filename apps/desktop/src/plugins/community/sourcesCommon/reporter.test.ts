import { describe, expect, it } from "vitest";
import { createPlaybackReporter } from "./reporter";

interface S {
  current: { id: string } | null;
  isPlaying: boolean;
  position: number;
  duration: number;
}

const idle: S = { current: null, isPlaying: false, position: 0, duration: 0 };
const loaded = (id: string, duration = 200): S => ({ current: { id }, isPlaying: false, position: 0, duration });

function setup() {
  const sent: string[] = [];
  const feed = createPlaybackReporter(
    (t) => (t.id.startsWith("x:") ? t.id.slice(2) : null),
    (event, id, pos, dur) => sent.push(`${event} ${id} @${pos}/${dur}`),
  );
  let prev: S = idle;
  return {
    sent,
    set(next: Partial<S>) {
      const state = { ...prev, ...next };
      feed(state, prev);
      prev = state;
    },
  };
}

describe("playback reporter", () => {
  it("reports start when one of its tracks plays, and stop with how far it got when skipped", () => {
    const r = setup();
    r.set(loaded("x:a"));
    expect(r.sent).toEqual([]);
    r.set({ isPlaying: true });
    expect(r.sent).toEqual(["start a @0/200"]);
    r.set({ position: 120 });
    expect(r.sent).toHaveLength(1);
    // Skipping to another track closes the first with the first track's position and length.
    r.set({ ...loaded("x:b", 90), isPlaying: true, position: 0 });
    expect(r.sent).toEqual(["start a @0/200", "stop a @120/200", "start b @0/90"]);
  });

  it("does not treat pausing as a stop, nor report again on resume", () => {
    const r = setup();
    r.set({ ...loaded("x:a"), isPlaying: true });
    r.set({ isPlaying: false, position: 30 });
    r.set({ isPlaying: true });
    expect(r.sent).toEqual(["start a @0/200"]);
  });

  it("reports stop when a track plays to its end", () => {
    const r = setup();
    r.set({ ...loaded("x:a"), isPlaying: true });
    r.set({ position: 199.5 });
    r.set({ isPlaying: false });
    expect(r.sent).toEqual(["start a @0/200", "stop a @199.5/200"]);
  });

  it("reports stop when playback is cleared, and ignores other sources entirely", () => {
    const r = setup();
    r.set({ ...loaded("x:a"), isPlaying: true, position: 12 });
    r.set({ current: null, isPlaying: false, position: 0, duration: 0 });
    expect(r.sent).toEqual(["start a @12/200", "stop a @12/200"]);
    r.set({ ...loaded("jellyfin:z"), isPlaying: true });
    r.set({ position: 100 });
    r.set({ current: null, isPlaying: false });
    expect(r.sent).toHaveLength(2);
  });
});