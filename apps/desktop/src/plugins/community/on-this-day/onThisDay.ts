import type { Play } from "@uma/shared";
import type { Track } from "@/shared/types";

/** Plays that happened on today's date in earlier years. Pure date maths in local time. */

/** How many days either side of today are looked at when the exact day was quiet. */
export const NEARBY_DAYS = 3;

export interface DayWindow {
  year: number;
  yearsAgo: number;
  /** Start of the exact day. */
  dayStart: number;
  /** End (exclusive) of the exact day. */
  dayEnd: number;
  /** Start of the wider window. */
  since: number;
  /** End (exclusive) of the wider window. */
  until: number;
}

/** The same calendar day `yearsAgo` years back. 29 February falls back to 28 February in non-leap years. */
export function dayWindow(now: Date, yearsAgo: number, nearby = NEARBY_DAYS): DayWindow {
  const year = now.getFullYear() - yearsAgo;
  const month = now.getMonth();
  let date = now.getDate();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  if (date > daysInMonth) date = daysInMonth;
  const dayStart = new Date(year, month, date).getTime();
  const dayEnd = new Date(year, month, date + 1).getTime();
  return {
    year,
    yearsAgo,
    dayStart,
    dayEnd,
    since: new Date(year, month, date - nearby).getTime(),
    until: new Date(year, month, date + nearby + 1).getTime(),
  };
}

export interface DayEntry {
  year: number;
  yearsAgo: number;
  /** True when the plays are from the exact day, false when from a few days around it. */
  exact: boolean;
  plays: Play[];
  /** Distinct tracks, most played first. */
  tracks: { track: Track; plays: number }[];
}

function distinctTracks(plays: Play[]): DayEntry["tracks"] {
  const map = new Map<string, { track: Track; plays: number; first: number }>();
  for (const p of plays) {
    const e = map.get(p.track.id);
    if (e) e.plays += 1;
    else map.set(p.track.id, { track: p.track, plays: 1, first: p.playedAt });
  }
  return [...map.values()].sort((a, b) => b.plays - a.plays || a.first - b.first).map(({ track, plays: n }) => ({ track, plays: n }));
}

/** Group plays into one entry per earlier year, preferring the exact day over its neighbours. */
export function groupByYear(plays: Play[], now: Date, maxYears = 10): DayEntry[] {
  const entries: DayEntry[] = [];
  for (let yearsAgo = 1; yearsAgo <= maxYears; yearsAgo++) {
    const w = dayWindow(now, yearsAgo);
    const near = plays.filter((p) => p.playedAt >= w.since && p.playedAt < w.until);
    if (near.length === 0) continue;
    const exact = near.filter((p) => p.playedAt >= w.dayStart && p.playedAt < w.dayEnd);
    const chosen = (exact.length > 0 ? exact : near).sort((a, b) => a.playedAt - b.playedAt);
    entries.push({ year: w.year, yearsAgo, exact: exact.length > 0, plays: chosen, tracks: distinctTracks(chosen) });
  }
  return entries;
}

export function describeEntry(entry: Pick<DayEntry, "year" | "yearsAgo" | "exact">): string {
  const when = entry.yearsAgo === 1 ? "A year ago" : `${entry.yearsAgo} years ago`;
  return entry.exact ? `${when} today (${entry.year})` : `Around this time ${entry.yearsAgo === 1 ? "last year" : `in ${entry.year}`}`;
}

/**
 * Look back year by year through a history source. `getPage(before)` returns up to a page of plays
 * older than `before`, newest first. Stops when a year has no history at all before it.
 */
export async function collectOnThisDay(
  getPage: (before: number) => Promise<Play[]>,
  now: Date,
  maxYears = 10,
): Promise<DayEntry[]> {
  const found: Play[] = [];
  for (let yearsAgo = 1; yearsAgo <= maxYears; yearsAgo++) {
    const w = dayWindow(now, yearsAgo);
    const page = await getPage(w.until);
    if (page.length === 0) break; // nothing older than this at all
    found.push(...page.filter((p) => p.playedAt >= w.since && p.playedAt < w.until));
  }
  return groupByYear(found, now, maxYears);
}