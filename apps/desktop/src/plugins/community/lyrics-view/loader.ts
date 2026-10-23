import type { Track } from "@/shared/types";
import type { Lyrics, LyricsProvider } from "../../types";
import { isInstrumental } from "./lrc";

/** Providers may take a third argument (`fresh`) to skip their own cache. */
type FreshAware = (track: Track, signal?: AbortSignal, options?: { fresh?: boolean }) => Promise<Lyrics | null>;

export interface FindOptions {
  /** A provider id to use alone, or undefined to try all of them in order. */
  providerId?: string;
  /** Ask again instead of using a provider's cache. */
  fresh?: boolean;
  signal?: AbortSignal;
}

export interface FindResult {
  lyrics: Lyrics | null;
  /** Which provider the lyrics came from. */
  providerId: string | null;
  /** One message per provider that failed (a provider that simply had no lyrics is not an error). */
  errors: { providerId: string; label: string; message: string }[];
}

function rank(lyrics: Lyrics): number {
  if (isInstrumental(lyrics)) return 1;
  return lyrics.synced ? 3 : 2;
}

/**
 * Ask providers for lyrics. With no provider chosen they are tried in order and the best answer
 * wins: synced lyrics end the search at once, plain lyrics are kept while later providers get a
 * chance to do better, and "instrumental" only counts when nobody has words.
 */
export async function findLyrics(providers: readonly LyricsProvider[], track: Track, options: FindOptions = {}): Promise<FindResult> {
  const chosen = options.providerId ? providers.filter((p) => p.id === options.providerId) : providers;
  const errors: FindResult["errors"] = [];
  let best: { lyrics: Lyrics; providerId: string } | null = null;

  for (const provider of chosen) {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const lyrics = await (provider.getLyrics as FreshAware)(track, options.signal, { fresh: options.fresh });
      if (!lyrics || !lyrics.lines.length) continue;
      if (!best || rank(lyrics) > rank(best.lyrics)) best = { lyrics, providerId: provider.id };
      if (rank(lyrics) === 3) break;
    } catch (err) {
      if (options.signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) throw err;
      errors.push({ providerId: provider.id, label: provider.label, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { lyrics: best?.lyrics ?? null, providerId: best?.providerId ?? null, errors };
}
