import type { PluginStorage } from "../../types";

interface Entry<T> {
  at: number;
  /** `null` is a remembered "not found". */
  v: T | null;
}

interface Saved<T> {
  /** Keys, oldest first. */
  order: string[];
  items: Record<string, Entry<T>>;
}

export interface CacheOptions {
  /** Most entries kept; the oldest go first. */
  maxEntries: number;
  /** Most bytes of saved JSON (approximate); the oldest go first. */
  maxBytes: number;
  /** How long a hit stays valid. */
  ttlMs: number;
  /** How long a remembered miss stays valid (defaults to `ttlMs`). */
  missTtlMs?: number;
  now?: () => number;
}

/**
 * A small persistent cache over a plugin's private storage, with a cap on entries and size.
 * Reads and writes never throw: a full or unavailable store just means nothing is cached.
 */
export class PersistentCache<T> {
  private data: Saved<T> | null = null;
  private readonly now: () => number;

  constructor(
    private readonly storage: PluginStorage,
    private readonly key: string,
    private readonly options: CacheOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  private load(): Saved<T> {
    if (this.data) return this.data;
    let saved: Saved<T> | null = null;
    try {
      saved = this.storage.get<Saved<T>>(this.key);
    } catch {
      saved = null;
    }
    const valid = saved && Array.isArray(saved.order) && saved.items && typeof saved.items === "object";
    this.data = valid ? saved! : { order: [], items: {} };
    return this.data;
  }

  /** `undefined` means "not cached"; `null` means "cached as not found". */
  get(key: string): T | null | undefined {
    const data = this.load();
    const entry = data.items[key];
    if (!entry) return undefined;
    const ttl = entry.v === null ? (this.options.missTtlMs ?? this.options.ttlMs) : this.options.ttlMs;
    if (this.now() - entry.at > ttl) {
      this.delete(key);
      return undefined;
    }
    return entry.v;
  }

  set(key: string, value: T | null): void {
    const data = this.load();
    if (key in data.items) data.order = data.order.filter((k) => k !== key);
    data.items[key] = { at: this.now(), v: value };
    data.order.push(key);
    this.trim(data);
    this.save();
  }

  delete(key: string): void {
    const data = this.load();
    if (!(key in data.items)) return;
    delete data.items[key];
    data.order = data.order.filter((k) => k !== key);
    this.save();
  }

  clear(): void {
    this.data = { order: [], items: {} };
    this.save();
  }

  get size(): number {
    return this.load().order.length;
  }

  private trim(data: Saved<T>): void {
    while (data.order.length > this.options.maxEntries) delete data.items[data.order.shift()!];
    // Evict oldest-first until the serialised form fits (always keep the newest entry).
    let bytes = JSON.stringify(data).length;
    while (bytes > this.options.maxBytes && data.order.length > 1) {
      const oldest = data.order.shift()!;
      bytes -= JSON.stringify(data.items[oldest]).length + oldest.length + 8;
      delete data.items[oldest];
    }
  }

  private save(): void {
    try {
      this.storage.set(this.key, this.data);
    } catch {
      // Storage full or blocked: keep working from memory.
    }
  }
}
