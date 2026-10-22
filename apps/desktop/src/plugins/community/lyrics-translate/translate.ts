import type { Track } from "@/shared/types";
import type { PersistentCache } from "../lyrics-view/cache";
import { trackKey } from "../lyrics-view/api";

/** Sends one batch of non-empty, distinct lines and returns one translation per line. */
export type SendBatch = (lines: string[], signal?: AbortSignal) => Promise<string[]>;

export interface BatchLimits {
  maxLines: number;
  maxChars: number;
}

export const DEFAULT_LIMITS: BatchLimits = { maxLines: 40, maxChars: 3000 };

/** The distinct, non-empty lines (a chorus is translated once), and where each input line maps. */
export function dedupeLines(lines: string[]): { unique: string[]; indexOf: (number | -1)[] } {
  const seen = new Map<string, number>();
  const unique: string[] = [];
  const indexOf = lines.map((raw) => {
    const text = raw.trim();
    if (!text) return -1;
    let at = seen.get(text);
    if (at === undefined) {
      at = unique.length;
      seen.set(text, at);
      unique.push(text);
    }
    return at;
  });
  return { unique, indexOf };
}

/** Split lines into consecutive batches no bigger than the limits (a long line gets a batch of its own). */
export function makeBatches(lines: string[], limits: BatchLimits = DEFAULT_LIMITS): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (current.length && (current.length >= limits.maxLines || chars + line.length > limits.maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(line);
    chars += line.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * Send one batch. If the model answers with the wrong number of lines (small models do), the
 * batch is split in half and tried again, down to single lines, so one bad answer costs a retry
 * rather than the whole song.
 */
export async function sendWithSplit(batch: string[], send: SendBatch, signal?: AbortSignal): Promise<string[]> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  let result: string[] | null = null;
  try {
    result = await send(batch, signal);
  } catch (err) {
    // A failure that is not about the answer shape (network, key, no model) ends the translation.
    if (!(err instanceof BadAnswer)) throw err;
  }
  if (result && result.length === batch.length) return result;
  if (batch.length === 1) return [result?.[0] ?? batch[0]!];
  const mid = Math.ceil(batch.length / 2);
  const first = await sendWithSplit(batch.slice(0, mid), send, signal);
  const second = await sendWithSplit(batch.slice(mid), send, signal);
  return [...first, ...second];
}

/** Thrown by a sender when the model replied, but not in the shape asked for. */
export class BadAnswer extends Error {}

/** Translate every line: de-duplicate, batch, send, and map the answers back to the input order. */
export async function translateLines(
  lines: string[],
  send: SendBatch,
  options: { limits?: BatchLimits; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<string[]> {
  const { unique, indexOf } = dedupeLines(lines);
  const translated: string[] = [];
  let done = 0;
  for (const batch of makeBatches(unique, options.limits)) {
    translated.push(...(await sendWithSplit(batch, send, options.signal)));
    done += batch.length;
    options.onProgress?.(done, unique.length);
  }
  return indexOf.map((i) => (i === -1 ? "" : (translated[i] ?? "")));
}

/** Cache key for a translation: the track, the language and the exact lines (lyrics can change). */
export function translationKey(track: Track, language: string, lines: string[]): string {
  let h = 0;
  for (const ch of lines.join("\n")) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return `${trackKey(track)}|${language.toLowerCase()}|${lines.length}:${(h >>> 0).toString(36)}`;
}

/** Translate with the per-track-and-language cache in front. */
export async function translateCached(
  cache: PersistentCache<string[]>,
  track: Track,
  language: string,
  lines: string[],
  send: SendBatch,
  signal?: AbortSignal,
): Promise<string[]> {
  const key = translationKey(track, language, lines);
  const hit = cache.get(key);
  if (hit && hit.length === lines.length) return hit;
  const result = await translateLines(lines, send, { signal });
  cache.set(key, result);
  return result;
}
