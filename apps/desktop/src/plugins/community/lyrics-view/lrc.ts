import type { Lyrics } from "../../types";

/** One line of lyrics. `timeSec` is missing when the lyrics are not synced. */
export type LyricLine = Lyrics["lines"][number];

/**
 * Providers that know a track has no words return this single line (with `synced: false`),
 * so the view can say "Instrumental" instead of "No lyrics found".
 */
export const INSTRUMENTAL_MARK = "♪ Instrumental ♪";

export function instrumentalLyrics(source: string): Lyrics {
  return { lines: [{ text: INSTRUMENTAL_MARK }], synced: false, source };
}

export function isInstrumental(lyrics: Lyrics | null | undefined): boolean {
  return !!lyrics && lyrics.lines.length === 1 && lyrics.lines[0]!.text === INSTRUMENTAL_MARK;
}

// [mm:ss], [mm:ss.xx], [mm:ss.xxx], [mm:ss:xx] and [hh:mm:ss.xx]. Minutes may run past 59.
const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?(?:[.:](\d{1,3}))?\]/g;
const TIME_AT_START = /^(?:\[(?:\d{1,3}):(?:\d{1,2})(?::\d{1,2})?(?:[.:]\d{1,3})?\]\s*)+/;
const META_TAG = /^\[([a-zA-Z#]+):(.*)\]\s*$/;
const WORD_TIME = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;

function tagSeconds(m: RegExpExecArray): number {
  // With a third group present the tag is hh:mm:ss; otherwise mm:ss.
  const [, a, b, c, frac] = m;
  const fraction = frac ? Number(`0.${frac}`) : 0;
  if (c !== undefined && frac === undefined) {
    // "[mm:ss:xx]" is ambiguous with "[hh:mm:ss]"; players treat a 2-digit last group as hundredths.
    return Number(a) * 60 + Number(b) + Number(`0.${c}`);
  }
  if (c !== undefined) return Number(a) * 3600 + Number(b) * 60 + Number(c) + fraction;
  return Number(a) * 60 + Number(b) + fraction;
}

export interface ParsedLrc {
  lines: LyricLine[];
  /** True when at least one line had a timestamp. */
  synced: boolean;
  /** The `[offset:]` tag in milliseconds (already applied to the line times). */
  offsetMs: number;
  meta: Record<string, string>;
}

/**
 * Parse LRC text. Handles several timestamps on one line (`[00:10.00][00:50.00]chorus`), the
 * `[offset:+500]` tag, `<mm:ss.xx>` word timestamps (stripped), CRLF, and timed empty lines
 * (kept as gaps). Lines are sorted by time. Text with no timestamps becomes unsynced lines.
 */
export function parseLrc(input: string): ParsedLrc {
  const meta: Record<string, string> = {};
  const timed: { timeSec: number; text: string; order: number }[] = [];
  const untimed: string[] = [];
  let offsetMs = 0;
  let order = 0;

  for (const raw of input.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) {
      untimed.push("");
      continue;
    }
    const head = TIME_AT_START.exec(line);
    if (!head) {
      const tag = META_TAG.exec(line);
      if (tag) {
        const key = tag[1]!.toLowerCase();
        const value = tag[2]!.trim();
        meta[key] = value;
        if (key === "offset") {
          const n = Number(value);
          if (Number.isFinite(n)) offsetMs = n;
        }
      } else {
        untimed.push(line);
      }
      continue;
    }
    const text = line.slice(head[0].length).replace(WORD_TIME, "").replace(/\s+/g, " ").trim();
    TIME_TAG.lastIndex = 0;
    let m: RegExpExecArray | null;
    const stamps = head[0];
    while ((m = TIME_TAG.exec(stamps))) timed.push({ timeSec: tagSeconds(m), text, order: order++ });
  }

  if (!timed.length) {
    return { lines: plainLines(untimed.join("\n")), synced: false, offsetMs, meta };
  }

  // A positive offset makes the words appear sooner, so it is subtracted from every time.
  const shift = offsetMs / 1000;
  timed.sort((a, b) => a.timeSec - b.timeSec || a.order - b.order);
  const lines = timed.map((t) => ({ timeSec: Math.max(0, round3(t.timeSec - shift)), text: t.text }));
  return { lines, synced: true, offsetMs, meta };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Unsynced text to lines: trims the ends and collapses runs of blank lines into one. */
export function plainLines(text: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/)) {
    const line = raw.replace(/\s+$/, "").trim();
    if (!line && (out.length === 0 || out[out.length - 1]!.text === "")) continue;
    out.push({ text: line });
  }
  while (out.length && out[out.length - 1]!.text === "") out.pop();
  return out;
}

/** Index of the line being sung at `positionSec` (-1 before the first line, or if unsynced). */
export function activeLineIndex(lines: readonly LyricLine[], positionSec: number, leadSec = 0): number {
  if (!lines.length || lines[0]!.timeSec === undefined) return -1;
  const t = positionSec + leadSec;
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = lines[mid]!.timeSec;
    if (at !== undefined && at <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** LRC (or plain) text to Lyrics, or null when it holds no words at all. */
export function lrcToLyrics(text: string, source: string): Lyrics | null {
  const parsed = parseLrc(text);
  if (!parsed.lines.some((l) => l.text)) return null;
  return { lines: parsed.lines, synced: parsed.synced, source };
}
