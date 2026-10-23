/**
 * Text normalisation for matching tracks across services. Pure functions, no I/O.
 *
 * The same recording is written many ways: "Song (feat. X) - 2011 Remaster", "Song [Live at Y]",
 * "SONG", "Sóng". Normalising removes the differences that do not change which recording it is
 * (case, accents, punctuation, remaster notes, featured artists) and keeps the ones that do (live,
 * remix, acoustic, instrumental, karaoke, demo).
 */

export type VersionFlag = "live" | "remix" | "acoustic" | "instrumental" | "karaoke" | "demo" | "cover";

export interface TitleParts {
  /** The title with notes removed, normalised. */
  base: string;
  /** Normalised names found in "feat." notes. */
  featured: string[];
  /** Version markers that make this a different recording. */
  flags: Set<VersionFlag>;
}

/** Lower-case, remove accents, unify the ampersand, drop punctuation and collapse spaces. Keeps letters and digits of any script. */
export function normalizeText(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\u00df/g, "ss")
    .replace(/&/g, " and ")
    .replace(/['\u2019`\u00b4]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const FEAT = /\b(?:feat|ft|featuring|with)\b\.?\s*(.*)$/i;
/** Inline notes only count with feat/ft: "Dance With Me" is not a featured artist. */
const INLINE_FEAT = /\b(?:feat|ft|featuring)\b\.?\s*(.*)$/i;
const IGNORABLE =
  /\b(?:remaster(?:ed)?|re-?master|mono|stereo|deluxe|expanded|bonus(?: track)?|explicit|clean|radio edit|single version|album version|single edit|extended|original mix|original version|digital|anniversary|edition|version|from .+|soundtrack|ost|\d{4})\b/i;

function classify(note: string, flags: Set<VersionFlag>, featured: string[]): "feat" | "ignore" | "flag" | "keep" {
  const n = normalizeText(note);
  if (!n) return "ignore";
  const feat = FEAT.exec(note);
  if (feat && /^\s*(?:feat|ft|featuring|with)\b/i.test(note.trim())) {
    featured.push(...splitArtists(feat[1]));
    return "feat";
  }
  let hit = false;
  const mark = (flag: VersionFlag, re: RegExp) => {
    if (re.test(n)) {
      flags.add(flag);
      hit = true;
    }
  };
  mark("live", /\b(?:live|concert|unplugged|in concert|on stage)\b/);
  mark("remix", /\b(?:remix|rework|bootleg|vip|re edit|refix|flip)\b/);
  mark("acoustic", /\bacoustic\b/);
  mark("instrumental", /\binstrumental\b/);
  mark("karaoke", /\bkaraoke\b/);
  mark("demo", /\b(?:demo|rough mix)\b/);
  mark("cover", /\b(?:cover|tribute)\b/);
  if (!hit && /\bmix\b/.test(n) && !/\b(?:original|extended|radio|album|single|club|stereo|mono)\b/.test(n)) {
    flags.add("remix");
    hit = true;
  }
  if (hit) return "flag";
  return IGNORABLE.test(n) ? "ignore" : "keep";
}

/** Split "A & B", "A, B", "A feat. B", "A x B", "A / B" into names (not normalised). */
export function splitArtists(input: string): string[] {
  return input
    .split(/\s*(?:,|;|\/|&|\band\b|\bx\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\+)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Take a raw title apart: the base title, featured artists and version flags. */
export function parseTitle(raw: string): TitleParts {
  const flags = new Set<VersionFlag>();
  const featured: string[] = [];
  let rest = raw;
  const kept: string[] = [];

  // Notes in (), [] or {}.
  rest = rest.replace(/[([{]([^()[\]{}]*)[)\]}]/g, (_m, inner: string) => {
    const kind = classify(inner, flags, featured);
    if (kind === "keep") kept.push(inner);
    return " ";
  });
  // Trailing " - note" segments such as " - Remastered 2011" or " - Live at Wembley".
  const segments = rest.split(/\s+[-\u2013\u2014]\s+/);
  const head = segments.shift() ?? "";
  const tail: string[] = [];
  for (const seg of segments) {
    const kind = classify(seg, flags, featured);
    if (kind === "keep") tail.push(seg);
  }
  rest = [head, ...tail].join(" ");
  // An unbracketed "feat. X" at the end.
  const inline = INLINE_FEAT.exec(rest);
  if (inline && inline.index > 0) {
    featured.push(...splitArtists(inline[1]));
    rest = rest.slice(0, inline.index);
  }
  const base = normalizeText([rest, ...kept].join(" "));
  return { base, featured: featured.map(normalizeText).filter(Boolean), flags };
}

/** Normalised artist names from "A & B feat. C". A leading "the" is dropped so "The Beatles" equals "Beatles". */
export function artistNames(inputs: string[]): string[] {
  const out = new Set<string>();
  for (const input of inputs) {
    for (const name of splitArtists(input)) {
      const n = normalizeText(name).replace(/^the /, "");
      if (n) out.add(n);
    }
    // Names such as "AC/DC" or "Simon & Garfunkel" are also known whole.
    const whole = normalizeText(input).replace(/^the /, "");
    if (whole) out.add(whole);
  }
  return [...out];
}

/** Levenshtein distance, two rows. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 1 for equal strings, 0 for nothing in common. */
export function similarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const direct = 1 - editDistance(a, b) / Math.max(a.length, b.length);
  // Word order and repeats should not matter much ("love me do" vs "do love me").
  const sortedA = a.split(" ").sort().join(" ");
  const sortedB = b.split(" ").sort().join(" ");
  const reordered = sortedA === sortedB ? 0.95 : 1 - editDistance(sortedA, sortedB) / Math.max(sortedA.length, sortedB.length);
  return Math.max(direct, reordered * 0.97);
}