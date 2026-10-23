/** "1:02:03" or "5:07". */
export function clock(totalSeconds: number | undefined | null): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds < 0) return "";
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** "1 h 5 min", "42 min", "<1 min". Reads better than a clock for long things. */
export function spoken(totalSeconds: number | undefined | null): string {
  if (!totalSeconds || !Number.isFinite(totalSeconds) || totalSeconds <= 0) return "";
  const min = Math.round(totalSeconds / 60);
  if (min < 1) return "<1 min";
  const h = Math.floor(min / 60);
  return h > 0 ? `${h} h${min % 60 ? ` ${min % 60} min` : ""}` : `${min} min`;
}

/** "Today", "Yesterday", "3 days ago", "12 Mar", "12 Mar 2022". */
export function dayLabel(epochMs: number | null | undefined, now = Date.now()): string {
  if (!epochMs) return "";
  const days = Math.floor((startOfDay(now) - startOfDay(epochMs)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  const d = new Date(epochMs);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export const SPEEDS = [0.8, 1, 1.2, 1.5, 1.75, 2] as const;

export function speedLabel(rate: number): string {
  return `${Number.isInteger(rate) ? rate.toFixed(1) : String(rate)}×`;
}

/** The next speed up (or down) the list from `rate`, staying inside it. */
export function stepSpeed(rate: number, direction: 1 | -1): number {
  const list = [...SPEEDS];
  let i = list.findIndex((s) => s >= rate - 0.001);
  if (i < 0) i = list.length - 1;
  return list[Math.min(list.length - 1, Math.max(0, i + direction))];
}

/** How far to step back when listening resumes: more after a longer break, none for a quick pause. */
export function rewindSeconds(idleMs: number): number {
  if (idleMs < 30_000) return 0;
  if (idleMs < 10 * 60_000) return 3;
  if (idleMs < 60 * 60_000) return 8;
  return 15;
}

/** Progress as a 0..1 fraction. */
export function fraction(position: number, duration: number): number {
  return duration > 0 && Number.isFinite(position) ? Math.min(1, Math.max(0, position / duration)) : 0;
}
/** A thin line of small facts: "Norway · MP3 128 kbps". Empty parts are skipped. */
export function joinFacts(parts: (string | number | undefined | null | false)[]): string {
  return parts.filter((p) => p !== undefined && p !== null && p !== false && p !== "").join(" · ");
}