import type { FastifyBaseLogger } from "fastify";

export interface BatchStatus {
  running: boolean;
  /** Items found when the run started. */
  total: number;
  done: number;
  failed: number;
  current: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  lastError: string | null;
}

export interface BatchOptions<T> {
  name: string;
  /** What still needs doing. Called when a run starts, so a stopped run resumes where it left off. */
  list: () => T[];
  label: (item: T) => string;
  /** Handle one item. Record its own result (also failures) so the item is not listed again. */
  work: (item: T, signal: AbortSignal) => Promise<void>;
  /** Rest between items so a big library does not hog the CPU or disk. */
  pauseMs: number;
  log?: FastifyBaseLogger;
}

/**
 * One-at-a-time background worker with progress, stop and resume. `start()` while a run is
 * active returns that run's promise, so a timer and an admin button can never overlap.
 */
export class BatchRunner<T> {
  private promise: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private state: BatchStatus = {
    running: false,
    total: 0,
    done: 0,
    failed: 0,
    current: null,
    startedAt: null,
    finishedAt: null,
    lastError: null,
  };

  constructor(private readonly opts: BatchOptions<T>) {}

  status(): BatchStatus {
    return { ...this.state };
  }

  /** How many items are waiting (computed fresh). */
  pending(): number {
    return this.opts.list().length;
  }

  start(): Promise<void> {
    if (this.promise) return this.promise;
    const abort = new AbortController();
    this.abort = abort;
    const items = this.opts.list();
    this.state = {
      running: true,
      total: items.length,
      done: 0,
      failed: 0,
      current: null,
      startedAt: Date.now(),
      finishedAt: null,
      lastError: null,
    };
    this.promise = (async () => {
      try {
        for (const item of items) {
          if (abort.signal.aborted) break;
          this.state.current = this.opts.label(item);
          try {
            await this.opts.work(item, abort.signal);
            this.state.done++;
          } catch (err) {
            if (abort.signal.aborted) break;
            this.state.failed++;
            this.state.lastError = err instanceof Error ? err.message : String(err);
            this.opts.log?.warn({ err, job: this.opts.name }, "batch item failed");
          }
          if (this.opts.pauseMs > 0 && !abort.signal.aborted) await sleep(this.opts.pauseMs, abort.signal);
        }
      } finally {
        this.state.running = false;
        this.state.current = null;
        this.state.finishedAt = Date.now();
        this.promise = null;
        this.abort = null;
      }
    })();
    return this.promise;
  }

  /** Stop after the current item. Waits for the run to wind down. */
  async stop(): Promise<void> {
    const running = this.promise;
    this.abort?.abort();
    await running?.catch(() => undefined);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
