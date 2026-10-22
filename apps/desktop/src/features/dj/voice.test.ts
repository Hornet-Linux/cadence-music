import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const player = { duck: 1, setDuck: (f: number) => (player.duck = f) };
vi.mock("@/player/playerStore", () => ({ usePlayer: { getState: () => player } }));

const { DUCK_LEVEL, speakIntro, stopSpeaking } = await import("./voice");

class FakeUtterance {
  voice: unknown = null;
  rate = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

describe("voice", () => {
  let spoken: FakeUtterance[];
  beforeEach(() => {
    vi.useFakeTimers();
    spoken = [];
    player.duck = 1;
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    vi.stubGlobal("speechSynthesis", {
      getVoices: () => [],
      speak: (u: FakeUtterance) => spoken.push(u),
      cancel: vi.fn(),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("turns the music down while speaking and back up after", () => {
    speakIntro("Here's one you'll love");
    expect(spoken[0].text).toBe("Here's one you'll love");
    vi.advanceTimersByTime(500);
    expect(player.duck).toBeCloseTo(DUCK_LEVEL);
    spoken[0].onend?.();
    vi.advanceTimersByTime(500);
    expect(player.duck).toBe(1);
  });

  it("restores the music if the engine never finishes", () => {
    speakIntro("hello");
    vi.advanceTimersByTime(20_000);
    expect(player.duck).toBe(1);
  });

  it("stopSpeaking cancels and restores", () => {
    speakIntro("hello");
    vi.advanceTimersByTime(500);
    stopSpeaking();
    vi.advanceTimersByTime(500);
    expect(player.duck).toBe(1);
    expect(speechSynthesis.cancel).toHaveBeenCalled();
  });

  it("ignores empty intros", () => {
    speakIntro("  ");
    expect(spoken).toHaveLength(0);
  });
});
