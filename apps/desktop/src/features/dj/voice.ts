import { usePlayer } from "@/player/playerStore";
import { getHostPersona, getSpeechEngine } from "./hooks";

/** Music level while the DJ talks. */
export const DUCK_LEVEL = 0.25;
const FADE_MS = 400;
const FADE_STEPS = 8;
/** A neural voice that hasn't finished by now is given up on (network synthesis can be slow). */
const ENGINE_LIMIT_MS = 45_000;

let fadeTimer: ReturnType<typeof setInterval> | null = null;
let speakSeq = 0;
let engineAbort: AbortController | null = null;

/** Glide the music volume to `target` (Spotify's SDK can't take many calls, so a few steps). */
function fadeTo(target: number): void {
  if (fadeTimer) clearInterval(fadeTimer);
  const from = usePlayer.getState().duck;
  let step = 0;
  fadeTimer = setInterval(() => {
    step++;
    usePlayer.getState().setDuck(from + ((target - from) * step) / FADE_STEPS);
    if (step >= FADE_STEPS && fadeTimer) {
      clearInterval(fadeTimer);
      fadeTimer = null;
    }
  }, FADE_MS / FADE_STEPS);
}

function synth(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
}

/** Prefer the personality's voice, then a natural-sounding English voice when the OS has one. */
export function pickVoice(voices: SpeechSynthesisVoice[], hint?: string): SpeechSynthesisVoice | undefined {
  const wanted = hint?.trim().toLowerCase();
  if (wanted) {
    const named = voices.find((v) => v.name.toLowerCase().includes(wanted));
    if (named) return named;
  }
  const english = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
  return (
    english.find((v) => /natural|neural|premium|enhanced/i.test(v.name)) ??
    english.find((v) => v.default) ??
    english[0]
  );
}

/**
 * Speak `text` over the music, which is turned down until the voice finishes.
 * A speech engine from a plugin (neural voices) goes first; if it can't speak,
 * the operating system's voice does, so an intro is never silently lost.
 */
export function speakIntro(text: string): void {
  const engine = getSpeechEngine();
  const s = synth();
  if (!text.trim() || (!engine && !s)) return;
  stopSpeaking();
  const id = ++speakSeq;
  let safety: ReturnType<typeof setTimeout> | undefined;
  const done = () => {
    if (id !== speakSeq) return;
    clearTimeout(safety);
    engineAbort = null;
    fadeTo(1);
  };

  let fellBack = false;
  const speakWithSystem = () => {
    if (id !== speakSeq || fellBack) return;
    fellBack = true;
    clearTimeout(safety);
    if (!s) return done();
    // Some engines never fire `end`; don't leave the music turned down.
    safety = setTimeout(done, 4_000 + text.length * 90);
    const prefs = getHostPersona()?.voice;
    const u = new SpeechSynthesisUtterance(text);
    const voice = pickVoice(s.getVoices(), prefs?.voiceHint);
    if (voice) u.voice = voice;
    u.rate = prefs?.rate ?? 1.05;
    if (prefs?.pitch !== undefined) u.pitch = prefs.pitch;
    u.onend = done;
    u.onerror = done;
    fadeTo(DUCK_LEVEL);
    s.speak(u);
  };

  if (!engine) return speakWithSystem();

  const abort = new AbortController();
  engineAbort = abort;
  safety = setTimeout(() => {
    abort.abort();
    speakWithSystem();
  }, ENGINE_LIMIT_MS);
  engine
    .speak(text, { ...getHostPersona()?.voice, signal: abort.signal, onPlaying: () => id === speakSeq && fadeTo(DUCK_LEVEL) })
    .then(
      (ok) => (ok ? done() : speakWithSystem()),
      () => speakWithSystem(),
    );
}

/** Cut the voice off and bring the music back up. */
export function stopSpeaking(): void {
  speakSeq++;
  engineAbort?.abort();
  engineAbort = null;
  synth()?.cancel();
  if (usePlayer.getState().duck < 1) fadeTo(1);
}
