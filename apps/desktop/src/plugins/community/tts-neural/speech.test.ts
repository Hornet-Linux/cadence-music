import { describe, expect, it, vi } from "vitest";
import type { SpeakOptions } from "@/features/dj/hooks";
import { DEFAULT_TTS, MAX_TEXT, PRESETS, createNeuralEngine, describeStatus, isConfigured, parseTtsConfig, requestSpeech, speechUrl, type TtsConfig } from "./speech";

const config: TtsConfig = { baseUrl: "http://localhost:8880/v1", model: "kokoro", voice: "af_heart", speed: 1 };
const audio = (bytes = 500) => new Response(new Uint8Array(bytes), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
const opts = (over: Partial<SpeakOptions> = {}): SpeakOptions => ({ signal: new AbortController().signal, onPlaying: vi.fn(), ...over });

describe("speechUrl", () => {
  it("joins /audio/speech onto the base, keeping /v1", () => {
    expect(speechUrl("http://localhost:8880/v1")).toBe("http://localhost:8880/v1/audio/speech");
    expect(speechUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1/audio/speech");
    expect(speechUrl("http://host:8000")).toBe("http://host:8000/audio/speech");
  });
  it("rejects anything that is not a plain http(s) address", () => {
    for (const bad of ["", "not a url", "file:///etc/passwd", "ftp://x/v1", "http://user:pw@host/v1"]) {
      expect(speechUrl(bad)).toBeNull();
    }
    expect(isConfigured(DEFAULT_TTS)).toBe(false);
    expect(PRESETS.every((p) => isConfigured(p.config))).toBe(true);
  });
});

describe("parseTtsConfig", () => {
  it("reads saved settings defensively", () => {
    expect(parseTtsConfig(null)).toEqual(DEFAULT_TTS);
    expect(parseTtsConfig({ baseUrl: 5, model: "", voice: null, speed: "fast" })).toEqual(DEFAULT_TTS);
    expect(parseTtsConfig({ baseUrl: " http://x/v1 ", model: "m", voice: "v", speed: 99 })).toEqual({ baseUrl: "http://x/v1", model: "m", voice: "v", speed: 4 });
  });
});

describe("requestSpeech", () => {
  it("posts the OpenAI speech request with the key and bounded text", async () => {
    const fetchImpl = vi.fn(async () => audio());
    const blob = await requestSpeech(config, "sk-1", "x".repeat(2000), { fetchImpl: fetchImpl as never });
    expect(blob.size).toBe(500);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:8880/v1/audio/speech");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-1");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "kokoro", voice: "af_heart", response_format: "mp3", speed: 1 });
    expect(body.input).toHaveLength(MAX_TEXT);
  });

  it("omits the key when there is none, and lets the host override the voice and speed", async () => {
    const fetchImpl = vi.fn(async () => audio());
    await requestSpeech(config, undefined, "hi", { voice: " bm_george ", speed: 9, fetchImpl: fetchImpl as never });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(String(init.body))).toMatchObject({ voice: "bm_george", speed: 4 });
  });

  it("explains each kind of failure", async () => {
    const run = (res: Response | Error) =>
      requestSpeech(config, undefined, "hi", { fetchImpl: (async () => (res instanceof Error ? Promise.reject(res) : res)) as never });
    await expect(run(new Response("no", { status: 401 }))).rejects.toThrow(/rejected the API key/);
    await expect(run(new Response("no", { status: 404 }))).rejects.toThrow(/\/audio\/speech/);
    await expect(run(new Response("no", { status: 422 }))).rejects.toThrow(/model or voice/);
    await expect(run(new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } }))).rejects.toThrow(/did not return audio/);
    await expect(run(audio(10))).rejects.toThrow(/empty audio/);
    await expect(run(new TypeError("Failed to fetch"))).rejects.toThrow(/Could not reach the speech server/);
    const timeout = new Error("t");
    timeout.name = "TimeoutError";
    await expect(run(timeout)).rejects.toThrow(/too long/);
    await expect(requestSpeech({ ...config, baseUrl: "" }, undefined, "hi", {})).rejects.toThrow(/Enter the speech server address/);
    expect(describeStatus(500)).toMatch(/500/);
  });
});

describe("neural engine and fallback", () => {
  const make = (fetchImpl: typeof fetch, over: Partial<Parameters<typeof createNeuralEngine>[0]> = {}) => {
    const report = vi.fn();
    const play = vi.fn(async (_b: Blob, _s: AbortSignal, onPlaying: () => void) => onPlaying());
    const engine = createNeuralEngine({ config: () => config, apiKey: async () => "k", fetchImpl, play, report, ...over });
    return { engine, report, play };
  };

  it("speaks and reports success; sound starting is passed on so the music is ducked then", async () => {
    const { engine, report, play } = make((async () => audio()) as never);
    const o = opts();
    expect(await engine.speak("hello", o)).toBe(true);
    expect(play).toHaveBeenCalledTimes(1);
    expect(o.onPlaying).toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith({ ok: true });
  });

  it("returns false (so the DJ uses a system voice) when the server fails, with a reason", async () => {
    const { engine, report, play } = make((async () => new Response("", { status: 500 })) as never);
    expect(await engine.speak("hello", opts())).toBe(false);
    expect(play).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith({ ok: false, message: expect.stringContaining("500") });
  });

  it("returns false when the network is down or playback fails", async () => {
    const down = make((async () => Promise.reject(new TypeError("Failed to fetch"))) as never);
    expect(await down.engine.speak("hi", opts())).toBe(false);
    const broken = make((async () => audio()) as never);
    const failing = createNeuralEngine({
      config: () => config,
      apiKey: async () => undefined,
      fetchImpl: (async () => audio()) as never,
      play: async () => Promise.reject(new Error("blocked")),
      report: broken.report,
    });
    expect(await failing.speak("hi", opts())).toBe(false);
    expect(broken.report).toHaveBeenCalledWith({ ok: false, message: "blocked" });
  });

  it("quietly returns false when no server is configured, without any network call", async () => {
    const fetchImpl = vi.fn();
    const { engine, report } = make(fetchImpl as never, { config: () => DEFAULT_TTS });
    expect(await engine.speak("hi", opts())).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("scales the configured speed by the host personality's pace and uses its engine voice", async () => {
    const fetchImpl = vi.fn(async () => audio());
    const { engine } = make(fetchImpl as never, { config: () => ({ ...config, speed: 1.2 }) });
    await engine.speak("hi", opts({ rate: 0.5, engineVoice: "bf_emma" }));
    const body = JSON.parse(String(((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]).body));
    expect(body.speed).toBeCloseTo(0.6);
    expect(body.voice).toBe("bf_emma");
  });

  it("does not report a failure when the intro was cut off on purpose", async () => {
    const abort = new AbortController();
    const { engine, report } = make((async () => {
      abort.abort();
      throw new DOMException("Aborted", "AbortError");
    }) as never);
    expect(await engine.speak("hi", opts({ signal: abort.signal }))).toBe(true);
    expect(report).not.toHaveBeenCalled();
  });
});
