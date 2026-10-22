/** Pure tag clean-up rules. They only propose changes; nothing is written anywhere here. */

export type TagField = "title" | "artist" | "album" | "albumArtist" | "trackNo";
export const TAG_FIELDS: TagField[] = ["title", "artist", "album", "albumArtist", "trackNo"];

export interface TagTrack {
  id: string;
  relPath: string;
  title: string;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  trackNo: number | null;
}

export type RuleName = "casing" | "feat" | "spacing" | "album-artist" | "track-number" | "title-from-filename";

export interface Suggestion {
  trackId: string;
  field: TagField;
  oldValue: string | null;
  newValue: string;
  /** The rules that produced the change, comma separated (usually one). */
  rule: string;
  reason: string;
}

const SMALL_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "nor", "of", "off", "on", "onto", "or", "per", "the", "to", "up", "via", "vs", "with",
]);
const KEEP_LOWER = new Set(["feat.", "vs.", "ft."]);
const ROMAN = /^(?:i{1,3}|iv|vi{0,3}|ix|x{1,3})$/i;

/** Capitalise like a title: small words stay lower-case except first and after an opening bracket or colon. */
export function titleCase(input: string): string {
  let first = true;
  return input.replace(/[\p{L}\p{N}][\p{L}\p{N}'\u2019.]*/gu, (word, offset: number, whole: string) => {
    const lower = word.toLowerCase();
    const prev = whole.slice(0, offset).trimEnd().slice(-1);
    const startsPhrase = first || prev === "(" || prev === "[" || prev === ":" || prev === "-" || prev === "/";
    first = false;
    if (KEEP_LOWER.has(lower)) return lower;
    const bare = lower.replace(/\.$/, "");
    if (!startsPhrase && SMALL_WORDS.has(bare)) return bare + (lower.endsWith(".") ? "." : "");
    if (ROMAN.test(bare) && word.length <= 4 && word === word.toUpperCase() && bare.length > 1) return word;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  });
}

const isAllUpper = (s: string) => s === s.toUpperCase() && s !== s.toLowerCase();
const isAllLower = (s: string) => s === s.toLowerCase() && s !== s.toUpperCase();

/** "ALL CAPS" titles and artists and "all lower case" titles are almost always sloppy tagging. */
export function fixCasing(text: string, field: TagField): string | null {
  // "feat." is lower-case by convention, so it must not hide an otherwise shouting title.
  const probe = text.replace(/\b(?:featuring|feat|ft)\b\.?/gi, " ");
  const letters = probe.replace(/[^\p{L}]/gu, "");
  if (letters.length < 4) return null;
  const words = probe.trim().split(/\s+/);
  if (isAllUpper(probe)) {
    // A single short word in capitals is an acronym or a stylised name (ABBA, REM), not shouting.
    if (words.length === 1 && letters.length <= 5) return null;
    return titleCase(text);
  }
  if (isAllLower(probe) && words.length >= 2 && (field === "title" || field === "album")) return titleCase(text);
  return null;
}

/** "ft." / "feat" / "featuring" all become "feat." */
export function normalizeFeat(text: string): string {
  return text.replace(/\b(?:featuring|feat|ft)\b\.?(?=\s)/gi, "feat.");
}

export function collapseSpaces(text: string): string {
  return text.replace(/\s{2,}/g, " ").trim();
}

/** Run the text rules in order; returns the new value and which rules changed it. */
export function cleanText(text: string, field: TagField): { value: string; rules: RuleName[] } {
  let value = text;
  const rules: RuleName[] = [];
  const step = (rule: RuleName, next: string | null) => {
    if (next !== null && next !== value) {
      value = next;
      rules.push(rule);
    }
  };
  step("spacing", collapseSpaces(value));
  if (field === "title" || field === "artist" || field === "albumArtist") step("feat", normalizeFeat(value));
  step("casing", fixCasing(value, field));
  return { value, rules };
}

const REASONS: Record<RuleName, string> = {
  casing: "Fix capitalisation",
  feat: "Write featured artists as feat.",
  spacing: "Remove extra spaces",
  "album-artist": "Fill in the album artist",
  "track-number": "Track number from the file name",
  "title-from-filename": "Title from the file name",
};

const baseName = (relPath: string) => {
  const file = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
};
const folderOf = (relPath: string) => (relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "");

/** "01 - Song", "1. Song", "01-05 Song" (disc-track), "07 Song" -> track number and the rest. */
export function parseFilenamePrefix(base: string): { trackNo: number; rest: string } | null {
  let m = /^(\d{1,2})[-.](\d{2,3})\s*[-._)]?\s+(\S.*)$/.exec(base);
  if (m) return { trackNo: Number(m[2]), rest: m[3]!.trim() };
  m = /^(\d{1,3})\s*[-._)]\s*(\S.*)$/.exec(base);
  if (m) return { trackNo: Number(m[1]), rest: m[2]!.trim() };
  m = /^(0\d{1,2})\s+(\S.*)$/.exec(base);
  if (m) return { trackNo: Number(m[1]), rest: m[2]!.trim() };
  return null;
}

const key = (s: string | null) => (s ?? "").trim().toLowerCase();

/** Album artist guesses for tracks that lack one: the shared artist of the album folder, or Various Artists. */
function albumArtistGuesses(tracks: TagTrack[]): Map<string, string> {
  const groups = new Map<string, TagTrack[]>();
  for (const t of tracks) {
    if (!t.album) continue;
    const k = `${folderOf(t.relPath)}|${key(t.album)}`;
    const list = groups.get(k) ?? [];
    list.push(t);
    groups.set(k, list);
  }
  const guesses = new Map<string, string>();
  for (const list of groups.values()) {
    const named = list.filter((t) => t.albumArtist);
    const known = new Set(named.map((t) => t.albumArtist!));
    // If other tracks of the album already agree on an album artist, follow them.
    let guess: string | null = known.size === 1 ? [...known][0]! : null;
    if (!guess && known.size === 0) {
      const artists = list.map((t) => t.artist).filter((a): a is string => Boolean(a));
      const distinct = new Set(artists.map(key));
      if (artists.length === list.length && distinct.size === 1) guess = artists[0]!;
      else if (list.length >= 3 && distinct.size >= 3) {
        const top = Math.max(...[...distinct].map((a) => artists.filter((x) => key(x) === a).length));
        if (top / artists.length <= 0.5) guess = "Various Artists";
      }
    }
    if (guess) for (const t of list) if (!t.albumArtist) guesses.set(t.id, guess);
  }
  return guesses;
}

/** All suggestions for a set of tracks (the library, or a test fixture). */
export function suggestForLibrary(tracks: TagTrack[]): Suggestion[] {
  const out: Suggestion[] = [];
  const guesses = albumArtistGuesses(tracks);

  for (const t of tracks) {
    const base = baseName(t.relPath);
    const add = (field: TagField, oldValue: string | null, newValue: string, rules: RuleName[]) => {
      out.push({ trackId: t.id, field, oldValue, newValue, rule: rules.join(","), reason: REASONS[rules[0]!] });
    };

    // Text fields: spacing, feat., casing.
    let title = t.title;
    const titleRules: RuleName[] = [];
    const prefix = parseFilenamePrefix(base);
    if (title === base && prefix) {
      // No title tag: the file name was used. Drop the "01 - " and a leading "Artist - ".
      let rest = prefix.rest;
      const dash = /^(.+?)\s+-\s+(\S.*)$/.exec(rest);
      if (dash && t.artist && key(dash[1]!) === key(t.artist)) rest = dash[2]!;
      if (rest !== title) {
        title = rest;
        titleRules.push("title-from-filename");
      }
    }
    for (const [field, current] of [
      ["title", title],
      ["artist", t.artist],
      ["album", t.album],
      ["albumArtist", t.albumArtist],
    ] as const) {
      if (!current) continue;
      const cleaned = cleanText(current, field);
      const rules = field === "title" ? [...titleRules, ...cleaned.rules] : cleaned.rules;
      const original = field === "title" ? t.title : current;
      if (cleaned.value !== original && rules.length > 0) add(field, original, cleaned.value, rules);
    }

    if (!t.albumArtist && guesses.has(t.id)) add("albumArtist", null, guesses.get(t.id)!, ["album-artist"]);
    if (t.trackNo === null && prefix && prefix.trackNo >= 1 && prefix.trackNo <= 999) {
      add("trackNo", null, String(prefix.trackNo), ["track-number"]);
    }
  }
  return out;
}