import type { Track } from "@/shared/types";
import type { Mood } from "./mood";

/** Choosing a queue for a mood from the library. Pure: random choices come from an injected source. */

export interface TrackTags {
  genres: string[];
  bpm?: number;
}

export interface StationOptions {
  size?: number;
  rng?: () => number;
  /** Extra words the person added for this mood. */
  extraKeywords?: string[];
  /** Tracks to leave out (e.g. what played in the last station). */
  avoid?: Set<string>;
  /** Most songs by one artist. */
  perArtist?: number;
}

export interface Station {
  queue: Track[];
  /** Songs chosen because they fit the mood. */
  matched: number;
  /** Songs added only to fill the queue. */
  filler: number;
  /** How many songs in the library carry genre tags at all. */
  tagged: number;
}

const norm = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does the word appear as a whole word in the text? */
const hasWord = (text: string, word: string) => new RegExp(`(^|[^a-z0-9])${escape(norm(word))}([^a-z0-9]|$)`).test(text);

/**
 * How well a song fits a mood. Genre tags count most, then tempo, then words in the names.
 * Zero or less means no evidence it fits.
 */
export function scoreTrack(track: Track, tags: TrackTags | undefined, mood: Mood, extraKeywords: string[] = []): number {
  let score = 0;
  if (tags) {
    const genres = tags.genres.map(norm);
    const hits = mood.genres.filter((g) => genres.some((t) => t === norm(g) || t.includes(norm(g)) || (norm(g).length > 3 && norm(g).includes(t) && t.length > 3)));
    score += Math.min(2, hits.length) * 4;
    if (tags.bpm) {
      const [lo, hi] = mood.bpm;
      if (tags.bpm >= lo && tags.bpm <= hi) score += 1.5;
      else if (tags.bpm < lo - 40 || tags.bpm > hi + 40) score -= 1;
    }
  }
  const text = norm(`${track.title} ${track.album ?? ""} ${track.artists.map((a) => a.name).join(" ")}`);
  const words = mood.keywords.filter((k) => hasWord(text, k)).length;
  score += Math.min(2, words) * 1.5;
  score += Math.min(2, extraKeywords.filter((k) => k.trim() && hasWord(text, k.trim())).length) * 2.5;
  return score;
}

export function shuffle<T>(items: T[], rng: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const artistOf = (t: Track) => norm(t.artists[0]?.name ?? "");

/** Build a queue for a mood: the best fits first (with some shuffling for variety), then fillers. */
export function buildStation(library: Track[], tags: Record<string, TrackTags>, mood: Mood, options: StationOptions = {}): Station {
  const size = options.size ?? 25;
  const rng = options.rng ?? Math.random;
  const perArtist = options.perArtist ?? 3;
  const avoid = options.avoid ?? new Set<string>();
  const extra = options.extraKeywords ?? [];

  const seen = new Set<string>();
  const candidates = library.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
  const fresh = candidates.filter((t) => !avoid.has(t.id));
  const pool = fresh.length >= Math.min(size, candidates.length) ? fresh : candidates;

  const scored = pool.map((t) => ({ t, score: scoreTrack(t, tags[t.id], mood, extra) }));
  const fits = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  // Take from a wider band of good fits than we need, so two stations in a row differ.
  const band = shuffle(fits.slice(0, size * 3), rng).sort((a, b) => b.score + rng() * 3 - (a.score + rng() * 3));
  const rest = shuffle(scored.filter((s) => s.score <= 0), rng);

  const queue: Track[] = [];
  const counts = new Map<string, number>();
  let matched = 0;
  const take = (t: Track, isMatch: boolean) => {
    const artist = artistOf(t);
    if ((counts.get(artist) ?? 0) >= perArtist) return;
    counts.set(artist, (counts.get(artist) ?? 0) + 1);
    queue.push(t);
    if (isMatch) matched += 1;
  };
  for (const s of band) {
    if (queue.length >= size) break;
    take(s.t, true);
  }
  for (const s of rest) {
    if (queue.length >= size) break;
    take(s.t, false);
  }
  // A small library may need the artist cap lifted to reach the size.
  if (queue.length < Math.min(size, pool.length)) {
    for (const s of [...band, ...rest]) {
      if (queue.length >= size) break;
      if (!queue.includes(s.t)) queue.push(s.t);
    }
  }
  return { queue, matched, filler: queue.length - matched, tagged: Object.keys(tags).length };
}

/** Lowercase, strip accents, brackets and punctuation, for matching the AI's picks to the library. */
export function normalizeName(s: string): string {
  return norm(s)
    .replace(/\s*[([].*?[)\]]/g, "")
    .replace(/\s+-\s+.*$/, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Find library songs for the AI's picks; picks the library doesn't have are ignored. */
export function matchPicks(picks: { artist: string; title: string }[], library: Track[]): Track[] {
  const byTitle = new Map<string, Track[]>();
  for (const t of library) {
    const key = normalizeName(t.title);
    byTitle.set(key, [...(byTitle.get(key) ?? []), t]);
  }
  const found: Track[] = [];
  const used = new Set<string>();
  for (const pick of picks) {
    const artist = normalizeName(pick.artist);
    const options = byTitle.get(normalizeName(pick.title)) ?? [];
    const hit = options.find((t) => !used.has(t.id) && t.artists.some((a) => normalizeName(a.name) === artist || normalizeName(a.name).includes(artist) || artist.includes(normalizeName(a.name))));
    if (hit) {
      used.add(hit.id);
      found.push(hit);
    }
  }
  return found;
}

/** The artists you have the most songs by: a taste hint for the AI that never lists individual songs. */
export function topLibraryArtists(library: Track[], limit = 20): string[] {
  const counts = new Map<string, { name: string; n: number }>();
  for (const t of library) {
    const name = t.artists[0]?.name?.trim();
    if (!name) continue;
    const key = norm(name);
    const e = counts.get(key) ?? { name, n: 0 };
    e.n += 1;
    counts.set(key, e);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, limit).map((e) => e.name);
}