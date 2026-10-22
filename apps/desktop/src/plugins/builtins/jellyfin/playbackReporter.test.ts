import { describe, expect, it } from "vitest";
import { createPlaybackReporter, PROGRESS_EVERY_MS } from "./playbackReporter";

interface S {
  current: { id: string } | null;
  isPlaying: boolean;
  position: number;
  duration: number;
}

const idle: S = { current: null, isPlaying: false, position: 0, duration: 0 };
const loaded = (id: string): S => ({ current: { id }, isPlaying: false, position: 0, duration: 200 });

function setup() {
  const sent: string[] = [];
  let clock = 1_000_000;
  const feed = createPlaybackReporter(
    (event, itemId, pos) => sent.push(`${event} ${itemId} @${pos}`),
    () => clock,
  );
  let prev: S = idle;
  return {
    sent,
    tick: (ms: number) => void (clock += ms),
    set(next: Partial<S>) {
      const state = { ...prev, ...next };
      feed(state, prev);
      prev = state;
    },
  };
}

describe("playback reporter", () => {
  it("reports start, progress every 30 s and stop on skip", () => {
    const r = setup();
    r.set(loaded("jellyfin:a"));
    expect(r.sent).toEqual([]); // loaded but not playing yet
    r.set({ isPlaying: true });
    expect(r.sent).toEqual(["start a @0"]);

    r.tick(10_000);
    r.set({ position: 10 });
    expect(r.sent).toHaveLength(1);
    r.tick(PROGRESS_EVERY_MS);
    r.set({ position: 40 });
    expect(r.sent.at(-1)).toBe("progress a @40");

    // Skipping: the next track is loaded (position reset, not playing yet).
    r.set(loaded("jellyfin:b"));
    expect(r.sent.at(-1)).toBe("stop a @40");
    r.set({ isPlaying: true });
    expect(r.sent.at(-1)).toBe("start b @0");
  });

  it("does not treat pause as a stop, and resumes without a second start", () => {
    const r = setup();
    r.set(loaded("jellyfin:a"));
    r.set({ isPlaying: true });
    r.set({ isPlaying: false, position: 20 });
    r.set({ isPlaying: true });
    expect(r.sent).toEqual(["start a @0"]);
  });

  it("stops when the track ends on its own", () => {
    const r = setup();
    r.set(loaded("jellyfin:a"));
    r.set({ isPlaying: true });
    r.set({ position: 199.5 });
    r.set({ isPlaying: false, position: 200 });
    expect(r.sent).toEqual(["start a @0", "stop a @200"]);
  });

  it("stops when playback is cleared", () => {
    const r = setup();
    r.set(loaded("jellyfin:a"));
    r.set({ isPlaying: true, position: 12 });
    r.set({ current: null, isPlaying: false, position: 0 });
    expect(r.sent.at(-1)).toBe("stop a @12");
  });

  it("never reports other sources, and stops when moving from Jellyfin to one", () => {
    const r = setup();
    r.set(loaded("spotify:track:1"));
    r.set({ isPlaying: true });
    r.tick(PROGRESS_EVERY_MS * 2);
    r.set({ position: 70 });
    r.set(loaded("server:9"));
    r.set({ isPlaying: true });
    expect(r.sent).toEqual([]);

    r.set(loaded("jellyfin:a"));
    r.set({ isPlaying: true });
    r.set({ ...loaded("local:1"), position: 0 });
    expect(r.sent).toEqual(["start a @0", "stop a @0"]);
  });
});
