import type { Play } from "@uma/shared";
import type { Track } from "@/shared/types";

/** Pure listening-statistics maths. Everything uses the viewer's local time zone. */

/** Tracks without a known length count as this many seconds when estimating listening time. */
export const DEFAULT_TRACK_SECONDS = 210;
/** A play counts at most this long, so one stuck track cannot swamp the total. */
const MAX_TRACK_SECONDS = 20 * 60;

export interface Range {
  id: string;
  label: string;
  /** Inclusive start, epoch ms. */
  since: number;
  /** Exclusive end, epoch ms. */
  until: number;
}

export interface ArtistStat {
  name: string;
  plays: number;
  seconds: number;
}
export interface TrackStat {
  track: Track;
  plays: number;
}
export interface AlbumStat {
  album: string;
  artist: string;
  artwork?: string;
  plays: number;
}
export interface Streaks {
  /** Days in a row ending today or yesterday (0 if the habit lapsed). */
  current: number;
  longest: number;
  activeDays: number;
}
export interface Stats {
  plays: number;
  uniqueTracks: number;
  uniqueArtists: number;
  /** Estimated listening time from track lengths. */
  seconds: number;
  topArtists: ArtistStat[];
  topTracks: TrackStat[];
  topAlbums: AlbumStat[];
  /** Seconds listened per weekday, Monday first. */
  secondsByWeekday: number[];
  /** Seconds listened per hour of the day, 0-23. */
  secondsByHour: number[];
  streaks: Streaks;
  /** Plays of tracks heard for the first time ever vs. tracks heard before. */
  newVsRepeat: { newPlays: number; repeatPlays: number; newTracks: number; newShare: number };
  busiestDay: { date: string; plays: number } | null;
}

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const weekdayName = (i: number) => WEEKDAY_NAMES[i] ?? "";

const trackKey = (t: Track) => t.id;
const artistName = (t: Track) => t.artists[0]?.name?.trim() || "Unknown artist";
const seconds = (t: Track) => Math.min(MAX_TRACK_SECONDS, t.durationSec && t.durationSec > 0 ? t.durationSec : DEFAULT_TRACK_SECONDS);

/** Day number counted in whole local days, so a streak survives daylight-saving changes. */
export function dayNumber(ms: number): number {
  const d = new Date(ms);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

export function dayLabel(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/** Longest run of consecutive days, and the run that is still alive on `today`. */
export function computeStreaks(days: Iterable<number>, today: number): Streaks {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  let prev = Number.NEGATIVE_INFINITY;
  const runEndingAt = new Map<number, number>();
  for (const day of sorted) {
    run = day === prev + 1 ? run + 1 : 1;
    runEndingAt.set(day, run);
    longest = Math.max(longest, run);
    prev = day;
  }
  // A streak is still alive if you listened today or yesterday.
  const current = runEndingAt.get(today) ?? runEndingAt.get(today - 1) ?? 0;
  return { current, longest, activeDays: sorted.length };
}

/** Rank a map of counts, highest first, breaking ties by name for a stable order. */
function rank<T extends { plays: number }>(items: T[], tie: (item: T) => string, limit: number): T[] {
  return items.sort((a, b) => b.plays - a.plays || tie(a).localeCompare(tie(b))).slice(0, limit);
}

/**
 * Work out the statistics for plays inside `range`. `allPlays` should be the whole history
 * (it decides whether a track is new to you or a repeat); `now` decides what counts as a live streak.
 */
export function aggregate(allPlays: Play[], range: Pick<Range, "since" | "until">, now = Date.now(), top = 10): Stats {
  const sortedAll = [...allPlays].sort((a, b) => a.playedAt - b.playedAt);
  const firstHeard = new Map<string, number>();
  for (const p of sortedAll) if (!firstHeard.has(trackKey(p.track))) firstHeard.set(trackKey(p.track), p.playedAt);

  const inRange = sortedAll.filter((p) => p.playedAt >= range.since && p.playedAt < range.until);

  const artists = new Map<string, ArtistStat>();
  const tracks = new Map<string, TrackStat>();
  const albums = new Map<string, AlbumStat>();
  const byWeekday = new Array<number>(7).fill(0);
  const byHour = new Array<number>(24).fill(0);
  const dayPlays = new Map<number, number>();
  let total = 0;
  let newPlays = 0;
  const newTracks = new Set<string>();

  for (const p of inRange) {
    const t = p.track;
    const secs = seconds(t);
    total += secs;
    const name = artistName(t);
    const akey = name.toLowerCase();
    const a = artists.get(akey) ?? { name, plays: 0, seconds: 0 };
    a.plays += 1;
    a.seconds += secs;
    artists.set(akey, a);

    const tk = trackKey(t);
    const ts = tracks.get(tk);
    if (ts) {
      ts.plays += 1;
      ts.track = t; // latest metadata wins
    } else tracks.set(tk, { track: t, plays: 1 });

    if (t.album) {
      const albumKey = `${t.album.toLowerCase()}\u0000${akey}`;
      const al = albums.get(albumKey) ?? { album: t.album, artist: name, artwork: t.artwork, plays: 0 };
      al.plays += 1;
      al.artwork = al.artwork ?? t.artwork;
      albums.set(albumKey, al);
    }

    const d = new Date(p.playedAt);
    byWeekday[(d.getDay() + 6) % 7] += secs;
    byHour[d.getHours()] += secs;
    const day = dayNumber(p.playedAt);
    dayPlays.set(day, (dayPlays.get(day) ?? 0) + 1);

    if (firstHeard.get(tk) === p.playedAt && !newTracks.has(tk)) {
      newTracks.add(tk);
      newPlays += 1;
    }
  }

  // Repeat plays are every play of a track that was already known before this play.
  const repeatPlays = inRange.length - newPlays;
  let busiest: Stats["busiestDay"] = null;
  for (const [day, count] of dayPlays) if (!busiest || count > busiest.plays || (count === busiest.plays && dayLabel(day) < busiest.date)) busiest = { date: dayLabel(day), plays: count };

  return {
    plays: inRange.length,
    uniqueTracks: tracks.size,
    uniqueArtists: artists.size,
    seconds: total,
    topArtists: rank([...artists.values()], (a) => a.name, top),
    topTracks: rank([...tracks.values()], (t) => t.track.title, top),
    topAlbums: rank([...albums.values()], (a) => a.album, top),
    secondsByWeekday: byWeekday,
    secondsByHour: byHour,
    streaks: computeStreaks(dayPlays.keys(), dayNumber(now)),
    newVsRepeat: {
      newPlays,
      repeatPlays,
      newTracks: newTracks.size,
      newShare: inRange.length === 0 ? 0 : newPlays / inRange.length,
    },
    busiestDay: busiest,
  };
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** The ranges offered in the picker; years come from the plays you actually have. */
export function makeRanges(now: Date, playYears: number[]): Range[] {
  const today = startOfDay(now);
  const tomorrow = today + 86_400_000;
  const ranges: Range[] = [
    { id: "7d", label: "Last 7 days", since: today - 6 * 86_400_000, until: tomorrow },
    { id: "30d", label: "Last 30 days", since: today - 29 * 86_400_000, until: tomorrow },
    { id: "month", label: "This month", since: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), until: tomorrow },
  ];
  const years = [...new Set([now.getFullYear(), ...playYears])].sort((a, b) => b - a);
  for (const y of years) {
    ranges.push({ id: `y${y}`, label: y === now.getFullYear() ? `${y} so far` : String(y), since: new Date(y, 0, 1).getTime(), until: y === now.getFullYear() ? tomorrow : new Date(y + 1, 0, 1).getTime() });
  }
  ranges.push({ id: "all", label: "All time", since: 0, until: Number.MAX_SAFE_INTEGER });
  return ranges;
}

export const yearsWithPlays = (plays: Play[]): number[] => [...new Set(plays.map((p) => new Date(p.playedAt).getFullYear()))];

export function formatHours(totalSeconds: number): string {
  const hours = totalSeconds / 3600;
  if (hours >= 10) return `${Math.round(hours)} h`;
  if (hours >= 1) return `${hours.toFixed(1)} h`;
  return `${Math.round(totalSeconds / 60)} min`;
}

/** The hour with the most listening, as "9 pm", or null with no data. */
export function peakHour(secondsByHour: number[]): string | null {
  const max = Math.max(...secondsByHour);
  if (max <= 0) return null;
  const h = secondsByHour.indexOf(max);
  const suffix = h < 12 ? "am" : "pm";
  return `${h % 12 === 0 ? 12 : h % 12} ${suffix}`;
}

export function peakWeekday(secondsByWeekday: number[]): string | null {
  const max = Math.max(...secondsByWeekday);
  return max > 0 ? weekdayName(secondsByWeekday.indexOf(max)) : null;
}

/** A short line describing the listener, for the year-in-review headline. */
export function headline(stats: Stats): string {
  if (stats.plays === 0) return "No listening in this period yet.";
  const hour = peakHour(stats.secondsByHour);
  const hourNum = stats.secondsByHour.indexOf(Math.max(...stats.secondsByHour));
  const when = hourNum < 5 ? "night owl" : hourNum < 12 ? "morning listener" : hourNum < 18 ? "afternoon listener" : "evening listener";
  return `A ${when}${hour ? `, most active around ${hour}` : ""}.`;
}