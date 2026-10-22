import { usePlayer } from "@/player/playerStore";

/** Music level while the DJ talks. */
export const DUCK_LEVEL = 0.25;
const FADE_MS = 400;
const FADE_STEPS = 8;

let fadeTimer: ReturnType<typeof setInterval> | null = null;
let speakSeq = 0;

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

/** Prefer a natural-sounding English voice when the OS has one. */
function pickVoice(s: SpeechSynthesis): SpeechSynthesisVoice | undefined {
  const voices = s.getVoices().filter((v) => v.lang.toLowerCase().startsWith("en"));
  return (
    voices.find((v) => /natural|neural|premium|enhanced/i.test(v.name)) ??
    voices.find((v) => v.default) ??
    voices[0]
  );
}

/** Speak `text` over the music, which is turned down until the voice finishes. */
export function speakIntro(text: string): void {
  const s = synth();
  if (!s || !text.trim()) return;
  stopSpeaking();
  const id = ++speakSeq;
  const done = () => {
    if (id !== speakSeq) return;
    clearTimeout(safety);
    fadeTo(1);
  };
  // Some engines never fire `end`; don't leave the music turned down.
  const safety = setTimeout(done, 4_000 + text.length * 90);

  const u = new SpeechSynthesisUtterance(text);
  const voice = pickVoice(s);
  if (voice) u.voice = voice;
  u.rate = 1.05;
  u.onend = done;
  u.onerror = done;
  fadeTo(DUCK_LEVEL);
  s.speak(u);
}

/** Cut the voice off and bring the music back up. */
export function stopSpeaking(): void {
  speakSeq++;
  synth()?.cancel();
  if (usePlayer.getState().duck < 1) fadeTo(1);
}
