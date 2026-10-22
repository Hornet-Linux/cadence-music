import type { SpeakOptions, SpeechEngine } from "@/features/dj/hooks";

// Spoken intros through an OpenAI-compatible text-to-speech server
// (POST {base}/audio/speech): OpenAI itself, or a local server such as
// Kokoro-FastAPI or openedai-speech (Piper). Any failure falls back to the
// operating system's voice, so an intro is never lost.

export interface TtsConfig {
  /** e.g. https://api.openai.com/v1 or http://localhost:8880/v1 */
  baseUrl: string;
  model: string;
  voice: string;
  /** 0.25 to 4; 1 is normal. */
  speed: number;
}

export const DEFAULT_TTS: TtsConfig = { baseUrl: "", model: "tts-1", voice: "alloy", speed: 1 };

export interface TtsPreset {
  id: string;
  name: string;
  config: TtsConfig;
  note: string;
}

export const PRESETS: TtsPreset[] = [
  { id: "openai", name: "OpenAI", config: { baseUrl: "https://api.openai.com/v1", model: "tts-1", voice: "alloy", speed: 1 }, note: "Needs an OpenAI API key." },
  {
    id: "kokoro",
    name: "Kokoro (local)",
    config: { baseUrl: "http://localhost:8880/v1", model: "kokoro", voice: "af_heart", speed: 1 },
    note: "Kokoro-FastAPI running on this computer.",
  },
  {
    id: "piper",
    name: "Piper (local)",
    config: { baseUrl: "http://localhost:8000/v1", model: "tts-1", voice: "alloy", speed: 1 },
    note: "openedai-speech with Piper voices.",
  },
];

export const MAX_TEXT = 600;
const REQUEST_TIMEOUT_MS = 30_000;

const clamp = (n: unknown, lo: number, hi: number, fallback: number) =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;

/** Read a saved config defensively. */
export function parseTtsConfig(raw: unknown): TtsConfig {
  const v = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof TtsConfig, unknown>>;
  const str = (x: unknown, fallback: string, max = 200) => (typeof x === "string" ? x.trim().slice(0, max) : fallback);
  return {
    baseUrl: str(v.baseUrl, ""),
    model: str(v.model, DEFAULT_TTS.model, 80) || DEFAULT_TTS.model,
    voice: str(v.voice, DEFAULT_TTS.voice, 80) || DEFAULT_TTS.voice,
    speed: clamp(v.speed, 0.25, 4, 1),
  };
}

/** The speech URL for a base like https://host/v1, or null if it isn't a usable http(s) address. */
export function speechUrl(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    const base = url.href.endsWith("/") ? url.href : url.href + "/";
    return new URL("audio/speech", base).toString();
  } catch {
    return null;
  }
}

export function isConfigured(config: TtsConfig): boolean {
  return speechUrl(config.baseUrl) !== null;
}

/** A failure with a message that tells the listener what to check. */
export class TtsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TtsError";
  }
}

export function describeStatus(status: number): string {
  if (status === 401 || status === 403) return "The speech server rejected the API key.";
  if (status === 404) return "The speech server has no /audio/speech endpoint. Check the URL (it usually ends in /v1) and the model name.";
  if (status === 429) return "The speech server is rate limiting requests.";
  if (status === 400 || status === 422) return "The speech server did not accept the model or voice name.";
  return `The speech server returned ${status}.`;
}

/** Ask the server for audio. Returns the audio bytes as a Blob. */
export async function requestSpeech(
  config: TtsConfig,
  apiKey: string | undefined,
  text: string,
  options: { voice?: string; speed?: number; signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<Blob> {
  const url = speechUrl(config.baseUrl);
  if (!url) throw new TtsError("Enter the speech server address in the neural voice settings.");
  const doFetch = options.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const cancel = () => controller.abort();
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  const signal = controller.signal;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model: config.model.trim(),
        voice: (options.voice || config.voice).trim(),
        input: text.slice(0, MAX_TEXT),
        response_format: "mp3",
        speed: clamp(options.speed, 0.25, 4, config.speed),
      }),
      signal,
    });
  } catch (e) {
    if (options.signal?.aborted) throw e;
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    clearTimeout(timer);
    throw new TtsError(
      timedOut
        ? "The speech server took too long to answer."
        : "Could not reach the speech server. Is it running, and does it allow requests from this app (CORS)?",
    );
  }
  if (!res.ok) {
    clearTimeout(timer);
    throw new TtsError(describeStatus(res.status), res.status);
  }
  const type = res.headers.get("content-type") ?? "";
  if (type && !/^(audio\/|application\/octet-stream)/i.test(type)) {
    clearTimeout(timer);
    throw new TtsError("The speech server did not return audio. Check the URL points at an OpenAI-compatible /v1 API.");
  }
  const blob = await res.blob().finally(() => clearTimeout(timer));
  if (blob.size < 100) throw new TtsError("The speech server returned empty audio.");
  return blob;
}

/** Play audio; resolves when it ends. `onPlaying` fires once sound starts. */
export type PlayBlob = (blob: Blob, signal: AbortSignal, onPlaying: () => void) => Promise<void>;

export const playBlob: PlayBlob = (blob, signal, onPlaying) =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      audio.removeAttribute("src");
      URL.revokeObjectURL(url);
    };
    const onAbort = () => {
      audio.pause();
      cleanup();
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    audio.addEventListener("playing", onPlaying, { once: true });
    audio.addEventListener("ended", () => (cleanup(), resolve()), { once: true });
    audio.addEventListener("error", () => (cleanup(), reject(new TtsError("The audio from the speech server could not be played."))), { once: true });
    audio.play().catch((e) => {
      cleanup();
      reject(e instanceof Error ? e : new TtsError("The browser blocked audio playback."));
    });
  });

export interface EngineDeps {
  config: () => TtsConfig;
  apiKey: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  play?: PlayBlob;
  /** Told how each intro went, for the settings page. */
  report?: (result: { ok: true } | { ok: false; message: string }) => void;
}

/** The neural voice as a speech engine for the DJ. Never throws: false means "use a system voice". */
export function createNeuralEngine(deps: EngineDeps): SpeechEngine {
  return {
    id: "tts-neural",
    async speak(text: string, options: SpeakOptions): Promise<boolean> {
      const config = deps.config();
      if (!isConfigured(config)) return false; // not set up yet: quietly use the system voice
      try {
        const blob = await requestSpeech(config, await deps.apiKey(), text, {
          voice: options.engineVoice,
          // The host personality's pace scales the speed chosen in settings.
          speed: config.speed * (options.rate ?? 1),
          signal: options.signal,
          fetchImpl: deps.fetchImpl,
        });
        if (options.signal.aborted) return true;
        await (deps.play ?? playBlob)(blob, options.signal, options.onPlaying);
        deps.report?.({ ok: true });
        return true;
      } catch (e) {
        if (options.signal.aborted) return true;
        deps.report?.({ ok: false, message: e instanceof Error ? e.message : String(e) });
        return false;
      }
    },
  };
}
