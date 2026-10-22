/** The shape of a smart playlist and the editor's working copy of it. Mirrors the server's rules. */

export type FieldType = "text" | "number" | "date" | "bool";
export type Field =
  | "title"
  | "artist"
  | "album"
  | "genre"
  | "year"
  | "playCount"
  | "lastPlayed"
  | "addedAt"
  | "loudness"
  | "bpm"
  | "energy"
  | "duration"
  | "favourite";

export type RuleValue = string | number | boolean | [number, number];
export interface Rule {
  field: Field;
  op: string;
  value?: RuleValue;
}

export type SortField =
  | "random"
  | "title"
  | "artist"
  | "album"
  | "year"
  | "playCount"
  | "lastPlayed"
  | "addedAt"
  | "loudness"
  | "bpm"
  | "energy"
  | "duration";

export interface Definition {
  match: "all" | "any";
  rules: Rule[];
  limit?: number;
  sort: { by: SortField; dir: "asc" | "desc" };
}

export interface SavedPlaylist {
  id: string;
  name: string;
  definition: Definition;
  createdAt: number;
  updatedAt: number;
}

export interface FieldInfo {
  label: string;
  type: FieldType;
  /** Shown next to the value box and in descriptions. */
  unit?: string;
  /** Shown next to the value box only. */
  hint?: string;
  /** Needs another server plugin before it has any data. */
  needs?: "loudness" | "audio-analysis";
}

export const FIELDS: Record<Field, FieldInfo> = {
  genre: { label: "Genre", type: "text" },
  artist: { label: "Artist", type: "text" },
  album: { label: "Album", type: "text" },
  title: { label: "Title", type: "text" },
  year: { label: "Year", type: "number" },
  playCount: { label: "Times played", type: "number" },
  lastPlayed: { label: "Last played", type: "date" },
  addedAt: { label: "Date added", type: "date" },
  favourite: { label: "Favourite", type: "bool" },
  bpm: { label: "Tempo", type: "number", unit: "BPM", needs: "audio-analysis" },
  energy: { label: "Energy", type: "number", hint: "0 to 1", needs: "audio-analysis" },
  loudness: { label: "Loudness", type: "number", unit: "LUFS", needs: "loudness" },
  duration: { label: "Length", type: "number", unit: "seconds" },
};

export const FIELD_ORDER: Field[] = [
  "genre",
  "artist",
  "album",
  "title",
  "year",
  "playCount",
  "lastPlayed",
  "addedAt",
  "favourite",
  "bpm",
  "energy",
  "loudness",
  "duration",
];

export const OP_LABELS: Record<FieldType, { op: string; label: string }[]> = {
  text: [
    { op: "is", label: "is" },
    { op: "isNot", label: "is not" },
    { op: "contains", label: "contains" },
    { op: "notContains", label: "does not contain" },
  ],
  number: [
    { op: "eq", label: "is" },
    { op: "neq", label: "is not" },
    { op: "gt", label: "is more than" },
    { op: "gte", label: "is at least" },
    { op: "lt", label: "is less than" },
    { op: "lte", label: "is at most" },
    { op: "between", label: "is between" },
  ],
  date: [
    { op: "inLast", label: "in the last" },
    { op: "notInLast", label: "not in the last" },
    { op: "never", label: "never" },
  ],
  bool: [{ op: "is", label: "is" }],
};

export const SORT_LABELS: Record<SortField, string> = {
  title: "Title",
  artist: "Artist",
  album: "Album",
  year: "Year",
  playCount: "Times played",
  lastPlayed: "Last played",
  addedAt: "Date added",
  loudness: "Loudness",
  bpm: "Tempo",
  energy: "Energy",
  duration: "Length",
  random: "Shuffled",
};

/** A rule as typed in the editor: values stay text until they are complete. */
export interface DraftRule {
  key: string;
  field: Field;
  op: string;
  a: string;
  b: string;
}

export interface Draft {
  name: string;
  match: "all" | "any";
  rules: DraftRule[];
  /** Empty means no limit. */
  limit: string;
  sortBy: SortField;
  sortDir: "asc" | "desc";
}

let counter = 0;
const nextKey = () => `r${++counter}`;

export function newRule(field: Field = "genre"): DraftRule {
  const type = FIELDS[field].type;
  return { key: nextKey(), field, op: OP_LABELS[type][0]!.op, a: type === "bool" ? "true" : "", b: "" };
}

/** Switching field keeps the rule if the operator still fits, otherwise starts that field over. */
export function changeField(rule: DraftRule, field: Field): DraftRule {
  const next = newRule(field);
  const sameType = FIELDS[field].type === FIELDS[rule.field].type;
  return sameType ? { ...rule, field } : { ...next, key: rule.key };
}

export function changeOp(rule: DraftRule, op: string): DraftRule {
  return { ...rule, op, b: op === "between" ? rule.b : "" };
}

export const emptyDraft = (): Draft => ({
  name: "",
  match: "all",
  rules: [newRule()],
  limit: "",
  sortBy: "title",
  sortDir: "asc",
});

const toNumber = (s: string): number | null => {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** The API rule for a draft, or null while it is incomplete (the editor then leaves it out of previews). */
export function toRule(d: DraftRule): Rule | null {
  const type = FIELDS[d.field].type;
  if (type === "text") return d.a.trim() === "" ? null : { field: d.field, op: d.op, value: d.a.trim() };
  if (type === "bool") return { field: d.field, op: d.op, value: d.a === "true" };
  if (d.op === "never") return { field: d.field, op: d.op };
  const a = toNumber(d.a);
  if (a === null) return null;
  if (d.op === "between") {
    const b = toNumber(d.b);
    return b === null ? null : { field: d.field, op: d.op, value: [Math.min(a, b), Math.max(a, b)] };
  }
  if (type === "date" && a < 0) return null;
  return { field: d.field, op: d.op, value: a };
}

export function toDefinition(draft: Draft): Definition {
  const limit = toNumber(draft.limit);
  const rules = draft.rules.map(toRule).filter((r): r is Rule => r !== null);
  return {
    match: draft.match,
    rules,
    ...(limit !== null && Number.isInteger(limit) && limit >= 1 ? { limit: Math.min(limit, 5000) } : {}),
    sort: { by: draft.sortBy, dir: draft.sortDir },
  };
}

export function fromDefinition(name: string, def: Definition): Draft {
  return {
    name,
    match: def.match,
    limit: def.limit ? String(def.limit) : "",
    sortBy: def.sort.by,
    sortDir: def.sort.dir,
    rules: def.rules.map((r) => {
      const between = Array.isArray(r.value);
      return {
        key: nextKey(),
        field: r.field,
        op: r.op,
        a: between ? String((r.value as [number, number])[0]) : r.value === undefined ? "" : String(r.value),
        b: between ? String((r.value as [number, number])[1]) : "",
      };
    }),
  };
}

/** How many of the draft's rules are still incomplete. */
export const incompleteRules = (draft: Draft): number => draft.rules.filter((r) => toRule(r) === null).length;

const opLabel = (field: Field, op: string) => OP_LABELS[FIELDS[field].type].find((o) => o.op === op)?.label ?? op;

export function describeRule(r: Rule): string {
  const info = FIELDS[r.field];
  const unit = info.unit ? ` ${info.unit}` : "";
  const label = info.label.replace(/ \(.*\)$/, "").toLowerCase();
  if (info.type === "bool") return r.value ? "is a favourite" : "is not a favourite";
  if (info.type === "date") {
    if (r.op === "never") return `${label} never`;
    return `${label} ${opLabel(r.field, r.op)} ${r.value} days`;
  }
  if (r.op === "between" && Array.isArray(r.value)) return `${label} between ${r.value[0]} and ${r.value[1]}${unit}`;
  return `${label} ${opLabel(r.field, r.op)} ${String(r.value)}${info.type === "number" ? unit : ""}`;
}

export function describeDefinition(def: Definition): string {
  const rules = def.rules.map(describeRule);
  const join = def.match === "all" ? " and " : " or ";
  const parts = [rules.length === 0 ? "Every song" : rules.join(join)];
  parts.push(
    def.sort.by === "random"
      ? "shuffled"
      : `by ${SORT_LABELS[def.sort.by].toLowerCase()}${def.sort.dir === "desc" ? " (descending)" : ""}`,
  );
  if (def.limit) parts.push(`first ${def.limit}`);
  return parts.join(", ");
}

export interface Template {
  id: string;
  label: string;
  name: string;
  definition: Definition;
}

export const TEMPLATES: Template[] = [
  {
    id: "recent",
    label: "Recently added",
    name: "Recently added",
    definition: { match: "all", rules: [{ field: "addedAt", op: "inLast", value: 30 }], sort: { by: "addedAt", dir: "desc" } },
  },
  {
    id: "unheard",
    label: "Never played",
    name: "Never played",
    definition: {
      match: "all",
      rules: [{ field: "playCount", op: "eq", value: 0 }],
      sort: { by: "random", dir: "asc" },
      limit: 100,
    },
  },
  {
    id: "forgotten",
    label: "Favourites I have not heard lately",
    name: "Forgotten favourites",
    definition: {
      match: "all",
      rules: [
        { field: "favourite", op: "is", value: true },
        { field: "lastPlayed", op: "notInLast", value: 60 },
      ],
      sort: { by: "random", dir: "asc" },
    },
  },
  {
    id: "workout",
    label: "Upbeat (needs tempo analysis)",
    name: "Upbeat",
    definition: {
      match: "all",
      rules: [
        { field: "bpm", op: "gte", value: 120 },
        { field: "energy", op: "gte", value: 0.6 },
      ],
      sort: { by: "random", dir: "asc" },
      limit: 100,
    },
  },
];

/** Rules that depend on analysis the server may not have run: used to warn before saving. */
export function missingData(
  draft: Draft,
  coverage: { loudness: number | null; bpm: number | null; energy: number | null; genre: number; year: number } | null,
): string[] {
  if (!coverage) return [];
  const warnings: string[] = [];
  for (const r of draft.rules) {
    const info = FIELDS[r.field];
    if (info.needs === "loudness" && coverage.loudness === null)
      warnings.push("Loudness needs the Loudness analysis plugin on the server.");
    if (info.needs === "audio-analysis" && (r.field === "bpm" ? coverage.bpm : coverage.energy) === null) {
      warnings.push("Tempo and energy need the Audio analysis plugin on the server.");
    }
    if (r.field === "genre" && coverage.genre === 0) warnings.push("No genres have been read from your files yet.");
    if (r.field === "year" && coverage.year === 0) warnings.push("No years have been read from your files yet.");
  }
  return [...new Set(warnings)];
}
