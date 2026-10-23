import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const player = { duck: 1, setDuck: (f: number) => (player.duck = f) };
vi.mock("@/player/playerStore", () => ({ usePlayer: { getState: () => player } }));

const { DUCK_LEVEL, pickVoice, speakIntro, stopSpeaking } = await import("./voice");
const { setHostPersona, setSpeechEngine } = await import("./hooks");

class FakeUtterance {
  voice: unknown = null;
  rate = 1;
  pitch = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

const voice = (name: string, lang = "en-US", isDefault = false) => ({ name, lang, default: isDefault }) as SpeechSynthesisVoice;

describe("speech engines and host voices", () => {
  let spoken: FakeUtterance[];
  beforeEach(() => {
    vi.useFakeTimers();
    spoken = [];
    player.duck = 1;
    setHostPersona(null);
    setSpeechEngine(null);
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    vi.stubGlobal("speechSynthesis", { getVoices: () => [voice("Alex"), voice("Samantha")], speak: (u: FakeUtterance) => spoken.push(u), cancel: vi.fn() });
  });
  afterEach(() => {
    setHostPersona(null);
    setSpeechEngine(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses the host personality's rate, pitch and preferred voice for system speech", () => {
    setHostPersona({ style: "calm", voice: { rate: 0.9, pitch: 0.8, voiceHint: "saman" } });
    speakIntro("good evening");
    expect(spoken[0].rate).toBe(0.9);
    expect(spoken[0].pitch).toBe(0.8);
    expect((spoken[0].voice as SpeechSynthesisVoice).name).toBe("Samantha");
  });

  it("picks a voice by hint, else a natural English one, else the default", () => {
    const voices = [voice("Alex"), voice("Microsoft Aria Online (Natural)"), voice("Thomas", "fr-FR")];
    expect(pickVoice(voices, "alex")?.name).toBe("Alex");
    expect(pickVoice(voices)?.name).toContain("Natural");
    expect(pickVoice(voices, "nobody")?.name).toContain("Natural");
    expect(pickVoice([], "x")).toBeUndefined();
  });

  it("plays through the engine and ducks the music only when sound starts; no system voice is used", async () => {
    let finish: (ok: boolean) => void = () => undefined;
    let onPlaying: () => void = () => undefined;
    setSpeechEngine({
      id: "fake",
      speak: (_t, o) => {
        onPlaying = o.onPlaying;
        return new Promise<boolean>((r) => (finish = r));
      },
    });
    speakIntro("hello there");
    vi.advanceTimersByTime(500);
    expect(player.duck).toBe(1); // still synthesizing: music untouched
    onPlaying();
    vi.advanceTimersByTime(500);
    expect(player.duck).toBeCloseTo(DUCK_LEVEL);
    finish(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(player.duck).toBe(1);
    expect(spoken).toHaveLength(0);
  });

  it("falls back to the system voice when the engine can't speak, or throws", async () => {
    setSpeechEngine({ id: "no", speak: async () => false });
    speakIntro("first");
    await vi.advanceTimersByTimeAsync(10);
    expect(spoken.map((u) => u.text)).toEqual(["first"]);
    spoken[0].onend?.();

    setSpeechEngine({ id: "boom", speak: async () => Promise.reject(new Error("down")) });
    speakIntro("second");
    await vi.advanceTimersByTimeAsync(10);
    expect(spoken.map((u) => u.text)).toEqual(["first", "second"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(player.duck).toBeCloseTo(DUCK_LEVEL); // music is turned down for the fallback voice
  });

  it("gives up on a stuck engine, uses the system voice once, and never leaves the music turned down", async () => {
    setSpeechEngine({ id: "stuck", speak: () => new Promise<boolean>(() => undefined) });
    speakIntro("hello");
    await vi.advanceTimersByTimeAsync(46_000);
    expect(spoken).toHaveLength(1);
    spoken[0].onend?.();
    await vi.advanceTimersByTimeAsync(500);
    expect(player.duck).toBe(1);
  });

  it("stopSpeaking cancels the engine and ignores its late answer", async () => {
    let finish: (ok: boolean) => void = () => undefined;
    let signal: AbortSignal | undefined;
    setSpeechEngine({
      id: "slow",
      speak: (_t, o) => {
        signal = o.signal;
        return new Promise<boolean>((r) => (finish = r));
      },
    });
    speakIntro("hello");
    stopSpeaking();
    expect(signal?.aborted).toBe(true);
    finish(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(spoken).toHaveLength(0);
  });

  it("does nothing when there is neither an engine nor system speech", () => {
    vi.stubGlobal("speechSynthesis", undefined);
    // @ts-expect-error simulate a browser without speech synthesis
    delete window.speechSynthesis;
    expect(() => speakIntro("hello")).not.toThrow();
    expect(player.duck).toBe(1);
  });
});
