export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (value === undefined || value === "" || !Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export const term = (value: unknown, max = 200): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

export const text = (v: unknown, max = 500): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
export const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);

/** Runs `fn` over `items` with at most `limit` in flight, keeping the order of results. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Last.fm's rule: a play counts after half the track or four minutes, and only for tracks over 30 seconds. */
export function playCounts(positionSec: number, durationSec: number | undefined): boolean {
  if (durationSec !== undefined && Number.isFinite(durationSec) && durationSec > 0) {
    if (durationSec <= 30) return false;
    return positionSec >= Math.min(durationSec / 2, 240);
  }
  return positionSec >= 240;
}

/** Removes anything that looks like a credential from text before it is logged. */
export function redact(value: string): string {
  return value
    .replace(/([?&](?:t|s|p|u|password|apiKey|X-Plex-Token|token)=)[^&\s"]+/gi, "$1[redacted]")
    .replace(/(X-Plex-Token"?\s*[:=]\s*"?)[^\s",]+/gi, "$1[redacted]");
}

/** A small map that forgets old entries, so a flood of ids can't grow memory. */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}