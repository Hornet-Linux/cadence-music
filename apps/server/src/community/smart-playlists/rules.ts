/** Smart playlist rules: validation and evaluation. Pure, so it is tested without a server. */

export type FieldType = "text" | "number" | "date" | "bool";

export const FIELDS = {
  title: "text",
  artist: "text",
  album: "text",
  genre: "text",
  year: "number",
  playCount: "number",
  lastPlayed: "date",
  addedAt: "date",
  loudness: "number",
  bpm: "number",
  energy: "number",
  duration: "number",
  favourite: "bool",
} as const satisfies Record<string, FieldType>;

export type Field = keyof typeof FIELDS;

export const OPS: Record<FieldType, readonly string[]> = {
  text: ["is", "isNot", "contains", "notContains"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  // "inLast": within the last N days. "never" (nothing recorded) suits last played.
  date: ["inLast", "notInLast", "never"],
  bool: ["is"],
};

export type RuleValue = string | number | boolean | [number, number];

export interface Rule {
  field: Field;
  op: string;
  value?: RuleValue;
}

export const SORT_FIELDS = [
  "random",
  "title",
  "artist",
  "album",
  "year",
  "playCount",
  "lastPlayed",
  "addedAt",
  "loudness",
  "bpm",
  "energy",
  "duration",
] as const;
export type SortField = (typeof SORT_FIELDS)[number];

export interface Definition {
  match: "all" | "any";
  rules: Rule[];
  /** Maximum number of tracks; omitted means no limit. */
  limit?: number;
  sort: { by: SortField; dir: "asc" | "desc" };
}

/** What the evaluator needs to know about each track. */
export interface SmartTrack {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  genre: string | null;
  year: number | null;
  playCount: number;
  /** Epoch ms of the last play by this person, or null. */
  lastPlayedAt: number | null;
  addedAt: number;
  /** Integrated loudness in LUFS. */
  loudness: number | null;
  bpm: number | null;
  energy: number | null;
  duration: number | null;
  favourite: boolean;
}

export const MAX_RULES = 20;
export const MAX_LIMIT = 5000;
const DAY = 86_400_000;

export type Validation = { ok: true; definition: Definition } | { ok: false; error: string };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Check an untrusted definition (from the API) and return a clean copy. */
export function validateDefinition(raw: unknown): Validation {
  if (!raw || typeof raw !== "object") return { ok: false, error: "definition_required" };
  const d = raw as Record<string, unknown>;
  const match = d.match === "any" ? "any" : d.match === "all" || d.match === undefined ? "all" : null;
  if (!match) return { ok: false, error: "invalid_match" };
  if (!Array.isArray(d.rules)) return { ok: false, error: "rules_required" };
  if (d.rules.length > MAX_RULES) return { ok: false, error: "too_many_rules" };

  const rules: Rule[] = [];
  for (const r of d.rules) {
    if (!r || typeof r !== "object") return { ok: false, error: "invalid_rule" };
    const { field, op, value } = r as { field?: unknown; op?: unknown; value?: unknown };
    if (typeof field !== "string" || !(field in FIELDS)) return { ok: false, error: "unknown_field" };
    const type = FIELDS[field as Field];
    if (typeof op !== "string" || !OPS[type].includes(op)) return { ok: false, error: "invalid_operator" };
    let clean: RuleValue | undefined;
    if (type === "text") {
      if (typeof value !== "string" || value.trim() === "" || value.length > 200) return { ok: false, error: "invalid_value" };
      clean = value.trim();
    } else if (type === "bool") {
      if (typeof value !== "boolean") return { ok: false, error: "invalid_value" };
      clean = value;
    } else if (op === "never") {
      clean = undefined;
    } else if (op === "between") {
      if (!Array.isArray(value) || value.length !== 2 || !isNum(value[0]) || !isNum(value[1]))
        return { ok: false, error: "invalid_value" };
      clean = value[0] <= value[1] ? [value[0], value[1]] : [value[1], value[0]];
    } else {
      if (!isNum(value)) return { ok: false, error: "invalid_value" };
      if (type === "date" && (value < 0 || value > 36_500)) return { ok: false, error: "invalid_value" };
      clean = value;
    }
    rules.push(clean === undefined ? { field: field as Field, op } : { field: field as Field, op, value: clean });
  }

  let limit: number | undefined;
  if (d.limit !== undefined && d.limit !== null) {
    if (!Number.isInteger(d.limit) || (d.limit as number) < 1 || (d.limit as number) > MAX_LIMIT)
      return { ok: false, error: "invalid_limit" };
    limit = d.limit as number;
  }

  const sortRaw = (d.sort ?? {}) as { by?: unknown; dir?: unknown };
  const by = sortRaw.by === undefined ? "title" : sortRaw.by;
  if (typeof by !== "string" || !(SORT_FIELDS as readonly string[]).includes(by)) return { ok: false, error: "invalid_sort" };
  const dir = sortRaw.dir === "desc" ? "desc" : sortRaw.dir === "asc" || sortRaw.dir === undefined ? "asc" : null;
  if (!dir) return { ok: false, error: "invalid_sort" };

  return {
    ok: true,
    definition: { match, rules, ...(limit !== undefined ? { limit } : {}), sort: { by: by as SortField, dir } },
  };
}

function fieldValue(t: SmartTrack, field: Field): string | number | boolean | null {
  switch (field) {
    case "title":
      return t.title;
    case "artist":
      return t.artist;
    case "album":
      return t.album;
    case "genre":
      return t.genre;
    case "year":
      return t.year;
    case "playCount":
      return t.playCount;
    case "lastPlayed":
      return t.lastPlayedAt;
    case "addedAt":
      return t.addedAt;
    case "loudness":
      return t.loudness;
    case "bpm":
      return t.bpm;
    case "energy":
      return t.energy;
    case "duration":
      return t.duration;
    case "favourite":
      return t.favourite;
  }
}

const lower = (s: string) => s.toLocaleLowerCase();

export function matchesRule(t: SmartTrack, rule: Rule, now: number): boolean {
  const actual = fieldValue(t, rule.field);
  const type = FIELDS[rule.field];
  if (type === "bool") return actual === rule.value;

  if (type === "text") {
    const want = lower(String(rule.value));
    const have = actual === null ? null : lower(String(actual));
    switch (rule.op) {
      case "is":
        return have === want;
      case "isNot":
        return have !== want;
      case "contains":
        return have !== null && have.includes(want);
      case "notContains":
        return have === null || !have.includes(want);
    }
    return false;
  }

  if (type === "date") {
    const at = actual as number | null;
    switch (rule.op) {
      case "never":
        return at === null;
      case "inLast":
        return at !== null && at >= now - Number(rule.value) * DAY;
      case "notInLast":
        return at === null || at < now - Number(rule.value) * DAY;
    }
    return false;
  }

  // Numbers. Unknown values (not analysed, not tagged) match only "not equal".
  const n = actual as number | null;
  if (n === null) return rule.op === "neq";
  switch (rule.op) {
    case "eq":
      return n === rule.value;
    case "neq":
      return n !== rule.value;
    case "gt":
      return n > (rule.value as number);
    case "gte":
      return n >= (rule.value as number);
    case "lt":
      return n < (rule.value as number);
    case "lte":
      return n <= (rule.value as number);
    case "between": {
      const [lo, hi] = rule.value as [number, number];
      return n >= lo && n <= hi;
    }
  }
  return false;
}

function sortValue(t: SmartTrack, by: SortField): string | number | null {
  switch (by) {
    case "title":
      return lower(t.title);
    case "artist":
      return t.artist === null ? null : lower(t.artist);
    case "album":
      return t.album === null ? null : lower(t.album);
    case "year":
      return t.year;
    case "playCount":
      return t.playCount;
    case "lastPlayed":
      return t.lastPlayedAt;
    case "addedAt":
      return t.addedAt;
    case "loudness":
      return t.loudness;
    case "bpm":
      return t.bpm;
    case "energy":
      return t.energy;
    case "duration":
      return t.duration;
    case "random":
      return null;
  }
}

/** Small seeded generator so a shuffled playlist keeps its order for the length of a listening session. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface EvaluateResult {
  /** Tracks matching the rules, before the limit. */
  total: number;
  tracks: SmartTrack[];
}

export function evaluate(
  all: SmartTrack[],
  def: Definition,
  now = Date.now(),
  random: () => number = Math.random,
): EvaluateResult {
  const matched = all.filter((t) => {
    if (def.rules.length === 0) return true;
    return def.match === "all" ? def.rules.every((r) => matchesRule(t, r, now)) : def.rules.some((r) => matchesRule(t, r, now));
  });

  const { by, dir } = def.sort;
  if (by === "random") {
    // Fisher-Yates on a copy.
    for (let i = matched.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [matched[i], matched[j]] = [matched[j]!, matched[i]!];
    }
  } else {
    const sign = dir === "desc" ? -1 : 1;
    matched.sort((a, b) => {
      const x = sortValue(a, by);
      const y = sortValue(b, by);
      // Tracks without a value always sort last, whichever way the list runs.
      if (x === null && y === null) return a.title.localeCompare(b.title);
      if (x === null) return 1;
      if (y === null) return -1;
      const c = typeof x === "string" ? x.localeCompare(y as string) : x - (y as number);
      return c !== 0 ? c * sign : a.title.localeCompare(b.title);
    });
  }
  return { total: matched.length, tracks: def.limit ? matched.slice(0, def.limit) : matched };
}
