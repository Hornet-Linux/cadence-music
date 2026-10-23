import { artistNames, normalizeText, parseTitle, similarity, type TitleParts, type VersionFlag } from "./normalize.js";

/** A track somebody wants (from a file or another service). */
export interface Wanted {
  title: string;
  artists: string[];
  album?: string;
  durationSec?: number;
}

/** A track that is available to play. */
export interface Candidate {
  id: string;
  title: string;
  artists: string[];
  album?: string;
  durationSec?: number;
}

export type Confidence = "high" | "medium" | "low" | "none";

export interface ScoreParts {
  title: number;
  /** null when either side has no artist. */
  artist: number | null;
  album: number | null;
  duration: number | null;
  /** Points removed because one side is live/remix/acoustic/... and the other is not. */
  versionPenalty: number;
}

export interface Scored {
  score: number;
  confidence: Confidence;
  parts: ScoreParts;
}

/** Score thresholds. Above HIGH a match can be accepted without looking; below LOW it is not offered. */
export const THRESHOLDS = { high: 0.85, medium: 0.65, low: 0.45 } as const;

const WEIGHTS = { title: 0.5, artist: 0.3, album: 0.05, duration: 0.15 };
const VERSION_PENALTY = 0.2;

export function confidenceOf(score: number): Confidence {
  if (score >= THRESHOLDS.high) return "high";
  if (score >= THRESHOLDS.medium) return "medium";
  if (score >= THRESHOLDS.low) return "low";
  return "none";
}

/** Everything about one side that scoring needs, computed once. */
export interface Prepared {
  title: TitleParts;
  artists: string[];
  album: string | null;
  durationSec: number | null;
}

/**
 * Untagged files often carry the track number in the title ("01 Warm Sine"). With no artist to go by, a leading
 * number followed by a word is taken as a track number ("99 Luftballons" keeps its number when it has an artist).
 */
export function stripTrackNumber(title: string, hasArtist: boolean): string {
  return hasArtist ? title : title.replace(/^d{1,3}[s._)-]+(?=D)/, "");
}

export function prepare(t: { title: string; artists: string[]; album?: string; durationSec?: number }): Prepared {
  const title = parseTitle(stripTrackNumber(t.title, t.artists.length > 0));
  return {
    title,
    // Featured artists from the title count as artists of the track.
    artists: artistNames([...t.artists, ...title.featured]),
    album: t.album ? albumKey(t.album) || null : null,
    durationSec: typeof t.durationSec === "number" && t.durationSec > 0 ? t.durationSec : null,
  };
}

/** Album names without "(Deluxe Edition)", "[Remastered]" and the like. */
function albumKey(album: string): string {
  return parseTitle(album).base;
}

function artistScore(w: string[], c: string[]): number {
  // How well the first-named (main) wanted artist is found, mixed with how many of all the wanted artists are found.
  const best = (name: string) => c.reduce((m, other) => Math.max(m, similarity(name, other)), 0);
  const scores = w.map(best);
  const primary = scores[0];
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  return 0.65 * primary + 0.35 * Math.max(mean, primary > 0.9 ? 0.9 : 0);
}

function durationScore(a: number, b: number): number {
  const diff = Math.abs(a - b);
  if (diff <= 2) return 1;
  if (diff <= 5) return 0.85;
  if (diff <= 10) return 0.5;
  if (diff <= 20) return 0.2;
  return 0;
}

function flagDifference(a: Set<VersionFlag>, b: Set<VersionFlag>): number {
  let n = 0;
  for (const f of a) if (!b.has(f)) n++;
  for (const f of b) if (!a.has(f)) n++;
  return n;
}

/** Score how well `c` is the track `w`. Both are prepared once with `prepare` when many comparisons are made. */
export function scorePrepared(w: Prepared, c: Prepared): Scored {
  const title = similarity(w.title.base, c.title.base);
  const artist = w.artists.length && c.artists.length ? artistScore(w.artists, c.artists) : null;
  const album = w.album && c.album ? similarity(w.album, c.album) : null;
  const duration = w.durationSec !== null && c.durationSec !== null ? durationScore(w.durationSec, c.durationSec) : null;

  let sum = WEIGHTS.title * title;
  let weight = WEIGHTS.title;
  if (artist !== null) {
    sum += WEIGHTS.artist * artist;
    weight += WEIGHTS.artist;
  }
  if (album !== null) {
    sum += WEIGHTS.album * album;
    weight += WEIGHTS.album;
  }
  if (duration !== null) {
    sum += WEIGHTS.duration * duration;
    weight += WEIGHTS.duration;
  }
  let score = sum / weight;

  const versionPenalty = VERSION_PENALTY * flagDifference(w.title.flags, c.title.flags);
  score -= versionPenalty;
  // Without an artist to compare, a title match alone is not trustworthy.
  if (artist === null) score = Math.min(score, 0.7);
  // Very different lengths mean a different recording (or a different song with the same name).
  if (w.durationSec !== null && c.durationSec !== null && Math.abs(w.durationSec - c.durationSec) > 30) score -= 0.1;
  // A title that does not resemble the wanted one is not a match, however well the artist fits.
  if (title < 0.5) score = Math.min(score, 0.4);
  // A different artist is a different recording ("Hurt" by Nine Inch Nails is not "Hurt" by Johnny Cash).
  if (artist !== null && artist < 0.4) score = Math.min(score, 0.6);

  score = Math.max(0, Math.min(1, score));
  return { score: Math.round(score * 1000) / 1000, confidence: confidenceOf(score), parts: { title, artist, album, duration, versionPenalty } };
}

export function scoreMatch(w: Wanted, c: Candidate): Scored {
  return scorePrepared(prepare(w), prepare(c));
}

export interface Ranked<C extends Candidate = Candidate> extends Scored {
  candidate: C;
}

const MAX_POSTINGS = 3000;
/** Stop adding words once this many candidates are in the pool. */
const POOL_ENOUGH = 200;
/** A word shared by more tracks than this is 'common'. */
const COMMON_WORD = 500;
/** Try first-letters matches only when no word was found at all (a misspelling). */
const PREFIX_BELOW = 1;
const MAX_PREFIX = 500;

/** A searchable set of candidates, so matching 500 wanted tracks against a 100k-track library stays fast. */
export class CandidateIndex<C extends Candidate = Candidate> {
  private readonly items: { candidate: C; prepared: Prepared }[] = [];
  private readonly byToken = new Map<string, number[]>();
  private readonly byPrefix = new Map<string, number[]>();
  /** How many candidates the last search scored (for tests and tuning: it shows how well the index prunes). */
  lastScored = 0;

  constructor(candidates: Iterable<C>) {
    for (const candidate of candidates) {
      const prepared = prepare(candidate);
      const i = this.items.push({ candidate, prepared }) - 1;
      const tokens = new Set(prepared.title.base.split(" ").filter(Boolean));
      for (const token of tokens) push(this.byToken, token, i);
      const first = prepared.title.base.replace(/ /g, "").slice(0, 4);
      if (first) push(this.byPrefix, first, i);
    }
  }

  get size(): number {
    return this.items.length;
  }

  /** Candidates that share a word (or the first letters) with the wanted title, best first. */
  search(wanted: Wanted, limit = 5, minScore: number = THRESHOLDS.low): Ranked<C>[] {
    const w = prepare(wanted);
    const tokens = [...new Set(w.title.base.split(" ").filter(Boolean))];
    const pool = new Set<number>();
    // Rarest word first: it points at the fewest tracks. More words are added only while the pool is still small,
    // so a very common word never drags in thousands of candidates, yet a misspelled rare word still has fallbacks.
    const postings = tokens.map((t) => this.byToken.get(t) ?? []).filter((p) => p.length > 0).sort((a, b) => a.length - b.length);
    for (const p of postings) {
      if (pool.size >= POOL_ENOUGH) break;
      // A common word adds nothing but noise once something more specific has been found.
      if (pool.size > 0 && p.length > COMMON_WORD) continue;
      for (const i of p.slice(0, MAX_POSTINGS)) pool.add(i);
    }
    // No (or few) shared words: a misspelling. Fall back to tracks starting with the same letters.
    const prefix = w.title.base.replace(/ /g, "").slice(0, 4);
    if (pool.size < PREFIX_BELOW && prefix) for (const i of (this.byPrefix.get(prefix) ?? []).slice(0, MAX_PREFIX)) pool.add(i);
    if (pool.size === 0 && prefix.length >= 3) for (const i of (this.byPrefix.get(prefix.slice(0, 3)) ?? []).slice(0, MAX_PREFIX)) pool.add(i);
    this.lastScored = pool.size;

    const ranked: Ranked<C>[] = [];
    for (const i of pool) {
      const item = this.items[i];
      const scored = scorePrepared(w, item.prepared);
      if (scored.score >= minScore) ranked.push({ ...scored, candidate: item.candidate });
    }
    ranked.sort((a, b) => b.score - a.score || a.candidate.title.length - b.candidate.title.length);
    return ranked.slice(0, limit);
  }
}

function push(map: Map<string, number[]>, key: string, value: number): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** A stable key for "the same wanted track", used to merge duplicates (scrobbles of one song). */
export function wantedKey(w: Wanted): string {
  const p = prepare(w);
  return `${p.title.base}|${p.artists[0] ?? ""}`;
}

export { normalizeText };