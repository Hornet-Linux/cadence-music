import { UpstreamError } from "./errors.js";

export interface GateOptions {
  /** Minimum time between the start of two requests. */
  gapMs: number;
  /** Requests allowed to wait; further ones are refused so the queue cannot grow forever. */
  maxQueue?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Lets work through one at a time, at least `gapMs` apart (MusicBrainz asks for at most
 * one request per second). Callers queue in order; a full queue is refused with `busy`.
 */
export class Gate {
  private last = Number.NEGATIVE_INFINITY;
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private readonly gapMs: number;
  private readonly maxQueue: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: GateOptions) {
    this.gapMs = options.gapMs;
    this.maxQueue = options.maxQueue ?? 40;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
  }

  get queued(): number {
    return this.waiting;
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    if (this.waiting >= this.maxQueue) return Promise.reject(new UpstreamError("busy"));
    this.waiting += 1;
    const run = this.tail.then(async () => {
      try {
        const wait = this.last + this.gapMs - this.now();
        if (wait > 0) await this.sleep(wait);
        this.last = this.now();
      } finally {
        this.waiting -= 1;
      }
      return task();
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}
