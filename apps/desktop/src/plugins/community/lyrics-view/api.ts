/**
 * The small public surface of the lyrics view, for other plugins.
 *
 * Lyrics providers need nothing from here (they use the host's `registerLyricsProvider`).
 * A plugin that adds to the lyrics page, such as translation, imports this module and registers
 * itself. The view keeps working with none registered, and a registered translator keeps working
 * when the view is switched off, so plugins stay decoupled.
 */
import { create } from "zustand";
import type { Track } from "@/shared/types";

export { activeLineIndex, INSTRUMENTAL_MARK, instrumentalLyrics, isInstrumental, lrcToLyrics, parseLrc, plainLines } from "./lrc";
export type { LyricLine, ParsedLrc } from "./lrc";
export { PersistentCache } from "./cache";

/** What the view asks a translator to do. */
export interface TranslateRequest {
  track: Track;
  /** Lyric lines in order. Empty strings are gaps and come back empty. */
  lines: string[];
  /** The language to translate into, by name ("English", "Japanese"). */
  target: string;
  signal?: AbortSignal;
}

/**
 * Turns lyric lines into another language.
 * `translate` resolves to one string per input line, in the same order. When it cannot work
 * (no AI provider, provider unreachable) it rejects with an Error whose message is meant to be
 * shown to the listener as is.
 */
export interface LyricsTranslator {
  id: string;
  label: string;
  translate: (request: TranslateRequest) => Promise<string[]>;
}

interface TranslatorState {
  translators: LyricsTranslator[];
}

/** The registry. Read it with `useLyricsTranslators` in components. */
export const useLyricsTranslators = create<TranslatorState>(() => ({ translators: [] }));

/** Add a translator (replacing one with the same id). Returns a function that removes it again. */
export function registerLyricsTranslator(translator: LyricsTranslator): () => void {
  useLyricsTranslators.setState((s) => ({
    translators: [...s.translators.filter((t) => t.id !== translator.id), translator],
  }));
  return () => {
    useLyricsTranslators.setState((s) => ({
      translators: s.translators.filter((t) => t !== translator),
    }));
  };
}

/** Languages offered in the view's translate menu. */
export const TRANSLATE_LANGUAGES = [
  "English",
  "Spanish",
  "French",
  "German",
  "Italian",
  "Portuguese",
  "Dutch",
  "Swedish",
  "Russian",
  "Japanese",
  "Korean",
  "Chinese (Simplified)",
  "Arabic",
  "Hindi",
] as const;

/** A stable key for a track, shared by the lyrics and translation caches. */
export function trackKey(track: Track): string {
  const artist = track.artists[0]?.name ?? "";
  return `${track.id}|${artist}|${track.title}`.toLowerCase();
}
