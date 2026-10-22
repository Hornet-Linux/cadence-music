interface Entry {
  count: number;
  resetAt: number;
}

export interface RateLimiterOptions {
  /** Hits allowed inside one window; the next ones are limited. */
  max: number;
  windowMs: number;
  /** Cap on tracked keys, so a flood of distinct keys cannot grow memory. */
  maxEntries?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

/**
 * Fixed-window counter per key. When the table is full it makes room by
 * dropping expired entries first and then the oldest ones, never by wiping
 * everything (which would also release every active lockout).
 */
export class RateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    this.max = options.max;
    this.windowMs = options.windowMs;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  isLimited(key: string): boolean {
    const entry = this.entries.get(key);
    return !!entry && entry.resetAt > this.now() && entry.count >= this.max;
  }

  /** Count one hit (a failed attempt, or a sign-up) against the key. */
  hit(key: string): void {
    const now = this.now();
    const entry = this.entries.get(key);
    if (entry && entry.resetAt > now) {
      entry.count++;
      return;
    }
    // Delete first so a renewed key moves to the back of the insertion order,
    // which is also expiry order since every window has the same length.
    this.entries.delete(key);
    this.makeRoom(now);
    this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  private makeRoom(now: number): void {
    if (this.entries.size < this.maxEntries) return;
    for (const [key, entry] of this.entries) if (entry.resetAt <= now) this.entries.delete(key);
    // Map iterates in insertion order, so the first keys are the oldest.
    for (const key of this.entries.keys()) {
      if (this.entries.size < this.maxEntries) break;
      this.entries.delete(key);
    }
  }
}
