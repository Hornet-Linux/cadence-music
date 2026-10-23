/** Small helpers the source plugins share. */

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (value === undefined || value === "" || !Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** A trimmed, length-limited string from user input, or undefined. */
export const term = (value: unknown, max = 200): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

/** Strips control characters and clips; for text that came from outside. */
export function clean(value: unknown, max = 500): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
}

export const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
export const unb64 = (s: string): string => Buffer.from(s, "base64url").toString("utf8");

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

/** A small in-memory cache with an expiry and a size cap (oldest entries go first). */
export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; at: number }>();
  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
  ) {}
  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, { value, at: Date.now() });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  delete(key: string): void {
    this.map.delete(key);
  }
}

/** Counts open streams, per user and overall, so one person can't tie up the server. */
export class StreamSlots {
  private total = 0;
  private readonly perUser = new Map<number, number>();
  constructor(
    private readonly maxTotal: number,
    private readonly maxPerUser: number,
  ) {}
  /** Returns a release function, or null when full. */
  take(userId: number): (() => void) | null {
    const mine = this.perUser.get(userId) ?? 0;
    if (this.total >= this.maxTotal || mine >= this.maxPerUser) return null;
    this.total++;
    this.perUser.set(userId, mine + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total--;
      const n = (this.perUser.get(userId) ?? 1) - 1;
      if (n <= 0) this.perUser.delete(userId);
      else this.perUser.set(userId, n);
    };
  }
}