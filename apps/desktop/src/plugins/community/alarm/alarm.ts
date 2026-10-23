/** Alarm scheduling maths. No timers or audio here, so it is easy to test. */

export type AlarmSource = { kind: "liked" } | { kind: "playlist"; id: string } | { kind: "queue" };

export interface Alarm {
  id: string;
  label: string;
  /** 24-hour "HH:MM", in the device's local time. */
  time: string;
  /** 0 = Sunday .. 6 = Saturday. Empty = ring once, at the next occurrence of `time`. */
  days: number[];
  enabled: boolean;
  source: AlarmSource;
  shuffle: boolean;
  /** Seconds to bring the volume up from near silence. 0 = start at full volume. */
  rampSec: number;
  /** When the alarm was last switched on or edited; occurrences before this are ignored. */
  armedAt: number;
  /** Scheduled time (ms) of the occurrence that was last handled (rung or missed). */
  handledAt: number;
}

export const MAX_ALARMS = 5;
/** An occurrence this late (the page was asleep) is skipped instead of ringing at a strange time. */
export const GRACE_MS = 10 * 60 * 1000;

export function parseTime(time: string): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59 ? { h, m } : null;
}

export function newAlarm(now: number, id: string): Alarm {
  return {
    id,
    label: "",
    time: "07:00",
    days: [1, 2, 3, 4, 5],
    enabled: true,
    source: { kind: "liked" },
    shuffle: true,
    rampSec: 30,
    armedAt: now,
    handledAt: 0,
  };
}

export function sanitizeAlarm(raw: Partial<Alarm> | null | undefined, fallbackId: string): Alarm | null {
  if (!raw || typeof raw !== "object") return null;
  const time = typeof raw.time === "string" && parseTime(raw.time) ? raw.time.trim().padStart(5, "0") : "07:00";
  const src = raw.source as AlarmSource | undefined;
  const source: AlarmSource =
    src?.kind === "playlist" && typeof src.id === "string" ? { kind: "playlist", id: src.id } : src?.kind === "queue" ? { kind: "queue" } : { kind: "liked" };
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : fallbackId,
    label: typeof raw.label === "string" ? raw.label.slice(0, 40) : "",
    time,
    days: [...new Set((Array.isArray(raw.days) ? raw.days : []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort(),
    enabled: raw.enabled !== false,
    source,
    shuffle: raw.shuffle !== false,
    rampSec: Math.min(300, Math.max(0, Math.round(num(raw.rampSec, 30)))),
    armedAt: num(raw.armedAt, 0),
    handledAt: num(raw.handledAt, 0),
  };
}

/** The `time` on the local calendar day that is `daysBack` days before `from`. */
function occurrence(from: Date, daysBack: number, h: number, m: number): Date {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() - daysBack, h, m, 0, 0);
  return d;
}

const matchesDay = (alarm: Alarm, d: Date) => alarm.days.length === 0 || alarm.days.includes(d.getDay());

/** The latest scheduled time at or before `now`, looking back a week. */
export function latestOccurrence(alarm: Alarm, now: Date): Date | null {
  const t = parseTime(alarm.time);
  if (!t) return null;
  for (let back = 0; back <= 7; back++) {
    const d = occurrence(now, back, t.h, t.m);
    if (d.getTime() <= now.getTime() && matchesDay(alarm, d)) return d;
  }
  return null;
}

/** The next time the alarm will ring, after `from`; null when it is off or invalid. */
export function nextOccurrence(alarm: Alarm, from: Date): Date | null {
  if (!alarm.enabled) return null;
  const t = parseTime(alarm.time);
  if (!t) return null;
  for (let ahead = 0; ahead <= 7; ahead++) {
    const d = occurrence(from, -ahead, t.h, t.m);
    if (d.getTime() > from.getTime() && matchesDay(alarm, d)) return d;
  }
  return null;
}

export type DueResult = { kind: "none" } | { kind: "ring"; at: number } | { kind: "missed"; at: number };

/**
 * Is there an occurrence we have not handled yet? Rings if it is recent, otherwise reports it
 * as missed (e.g. the phone suspended the page overnight).
 */
export function checkAlarm(alarm: Alarm, now: Date, graceMs = GRACE_MS): DueResult {
  if (!alarm.enabled) return { kind: "none" };
  const latest = latestOccurrence(alarm, now);
  if (!latest) return { kind: "none" };
  const at = latest.getTime();
  if (at <= Math.max(alarm.armedAt, alarm.handledAt)) return { kind: "none" };
  return now.getTime() - at <= graceMs ? { kind: "ring", at } : { kind: "missed", at };
}

/** Volume multiplier while waking up: starts at 5% and rises smoothly to full. */
export function rampGain(elapsedSec: number, rampSec: number): number {
  if (!(rampSec > 0) || elapsedSec >= rampSec) return 1;
  const t = Math.max(0, elapsedSec) / rampSec;
  return 0.05 + 0.95 * t * t;
}

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function describeDays(days: number[]): string {
  if (days.length === 0) return "Once";
  if (days.length === 7) return "Every day";
  const key = days.join(",");
  if (key === "1,2,3,4,5") return "Weekdays";
  if (key === "0,6") return "Weekends";
  return days.map((d) => DAY_NAMES[d]).join(", ");
}

export function describeNext(next: Date | null, now: Date): string {
  if (!next) return "Off";
  const mins = Math.round((next.getTime() - now.getTime()) / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const when = h >= 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : h > 0 ? `${h} h ${m} min` : `${Math.max(1, m)} min`;
  return `Rings in ${when} (${DAY_NAMES[next.getDay()]} ${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")})`;
}
