/**
 * Matching songs an AI picked ("Artist" + "Title", spelled however the model
 * remembers them) to tracks in a Jellyfin library. Both artist and title have
 * to match closely; a wrong song is worse than a missing one.
 */

// Words that mark a different edition of the same song rather than a different song.
const NOISE_WORDS =
  "remaster(?:ed)?|digital remaster|re-?master|mono|stereo|original mix|album version|single version|explicit|clean|deluxe|bonus track|radio edit|remix edit";

/** "(Remastered 2011)", "[feat. X]", "- 2011 Remaster", "(ft. X)" and the like. */
const BRACKETED_NOISE = new RegExp(
  `[(\\[][^)\\]]*\\b(?:${NOISE_WORDS}|feat\\.?|ft\\.?|featuring|with)\\b[^)\\]]*[)\\]]`,
  "gi",
);
const DASHED_NOISE = new RegExp(`\\s[-–—]\\s[^-–—]*\\b(?:${NOISE_WORDS})\\b.*$`, "i");
const FEAT_TAIL = /\s(?:feat\.?|ft\.?|featuring)\s.*$/i;

/** Lower-case, no accents, punctuation turned into spaces. */
export function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/['’`.]/g, "") // "D.A.N.C.E." is "dance", "Don't" is "dont"
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeTitle(title: string): string {
  const cleaned = title.replace(BRACKETED_NOISE, " ").replace(DASHED_NOISE, "").replace(FEAT_TAIL, "");
  return fold(cleaned);
}

/** The title with edition noise removed but its punctuation intact, for a Jellyfin search. */
export function searchTitle(title: string): string {
  return title.replace(BRACKETED_NOISE, " ").replace(DASHED_NOISE, "").replace(FEAT_TAIL, "").replace(/\s+/g, " ").trim() || title.trim();
}

/** One artist name with "the" and credits dropped. */
function foldArtist(name: string): string {
  return fold(name.replace(BRACKETED_NOISE, " ").replace(FEAT_TAIL, "")).replace(/^the /, "");
}

/** "A & B", "A, B", "A feat. B", "A x B" -> each name, plus the whole string. */
export function artistKeys(artist: string): string[] {
  const keys = new Set<string>();
  const whole = foldArtist(artist);
  if (whole) keys.add(whole);
  const parts = artist.replace(FEAT_TAIL, "").split(/\s*(?:,|;|\/|&|\band\b|\bx\b|\bwith\b|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b)\s*/i);
  if (parts.length > 1) for (const p of parts) if (foldArtist(p)) keys.add(foldArtist(p));
  return [...keys];
}

/** Edit-distance based similarity, 0..1. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) / Math.max(m, n) > 0.25) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return 1 - prev[n] / Math.max(m, n);
}

const TITLE_MIN = 0.9;
const ARTIST_MIN = 0.88;
/** Short names differ by one letter and are a different word, so fuzziness needs some length. */
const FUZZY_MIN_LENGTH = 6;

function fuzzy(a: string, b: string, min: number): number {
  if (a === b) return 1;
  if (Math.min(a.length, b.length) < FUZZY_MIN_LENGTH) return 0;
  const s = similarity(a, b);
  return s >= min ? s : 0;
}

export interface Candidate {
  title: string;
  artists: string[];
}

/** 0 when the candidate isn't the song; otherwise higher is better. */
export function scoreCandidate(pick: { artist: string; title: string }, candidate: Candidate): number {
  const wantTitle = normalizeTitle(pick.title);
  const gotTitle = normalizeTitle(candidate.title);
  if (!wantTitle || !gotTitle) return 0;
  const titleScore = fuzzy(wantTitle, gotTitle, TITLE_MIN);
  if (!titleScore) return 0;

  const wanted = artistKeys(pick.artist);
  const got = new Set(candidate.artists.flatMap(artistKeys));
  let artistScore = 0;
  for (const w of wanted) for (const g of got) artistScore = Math.max(artistScore, fuzzy(w, g, ARTIST_MIN));
  if (!artistScore) return 0;
  return titleScore * 0.6 + artistScore * 0.4;
}

/** The index of the best candidate, or -1. Earlier candidates win ties. */
export function pickBest(pick: { artist: string; title: string }, candidates: Candidate[]): number {
  let best = -1;
  let bestScore = 0;
  candidates.forEach((c, i) => {
    const s = scoreCandidate(pick, c);
    if (s > bestScore) {
      best = i;
      bestScore = s;
    }
  });
  return best;
}
