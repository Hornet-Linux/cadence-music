// Places where plugins adjust the DJ without the DJ knowing about them: the
// host's personality, how intros are spoken, and what the listener's reactions
// were. Each is empty until a plugin sets it, and goes back to empty when the
// plugin is turned off.

/** How the DJ host sounds, set by a personality. */
export interface HostPersona {
  /** One or two sentences telling the model how to word the intros. */
  style: string;
  /** System voice settings (and a hint for choosing the voice) used when speaking intros. */
  voice?: VoicePrefs;
}

export interface VoicePrefs {
  /** Speech rate, 1 is normal. */
  rate?: number;
  /** Pitch, 1 is normal (system voices only). */
  pitch?: number;
  /** Prefer a system voice whose name matches this (case-insensitive substring). */
  voiceHint?: string;
  /** A voice name for a neural speech engine (overrides the engine's default). */
  engineVoice?: string;
}

export interface SpeakOptions extends VoicePrefs {
  signal: AbortSignal;
  /** Call when sound actually starts, so the music is turned down only then. */
  onPlaying: () => void;
}

/** A way to speak intros besides the operating system's voices. */
export interface SpeechEngine {
  id: string;
  /**
   * Speak `text`. Resolve true once it has finished, false if this engine
   * can't speak right now (the DJ then uses a system voice). Reject = false.
   */
  speak: (text: string, options: SpeakOptions) => Promise<boolean>;
}

let persona: HostPersona | null = null;
let engine: SpeechEngine | null = null;
let feedback: (() => string[]) | null = null;

export function setHostPersona(next: HostPersona | null): void {
  persona = next;
}
export const getHostPersona = (): HostPersona | null => persona;

export function setSpeechEngine(next: SpeechEngine | null): void {
  engine = next;
}
export const getSpeechEngine = (): SpeechEngine | null => engine;

/** Where the DJ asks what the listener skipped or finished (the mood radio provides it). */
export function setFeedbackSource(next: (() => string[]) | null): void {
  feedback = next;
}
export function getFeedbackNotes(): string[] {
  try {
    return feedback?.() ?? [];
  } catch {
    return [];
  }
}
