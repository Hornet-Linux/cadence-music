import type { FastifyBaseLogger } from "fastify";

/** A recorded play, as plugins see it (the same shape the history API stores). */
export interface PlayEvent {
  userId: number;
  track: { id: string; title: string; artists: { id: string; name: string }[]; album?: string; durationSec?: number; source?: string };
  /** Epoch milliseconds the play started. */
  playedAt: number;
}

export interface ServerEventMap {
  /** A play was newly stored in someone's history (not a duplicate re-upload). */
  "play.recorded": PlayEvent;
}

/** Small typed event bus that built-in and community plugins share. A throwing listener never affects others. */
export class ServerEvents {
  private readonly listeners = new Map<keyof ServerEventMap, Set<(payload: never) => void>>();

  constructor(private readonly log?: FastifyBaseLogger) {}

  on<K extends keyof ServerEventMap>(event: K, listener: (payload: ServerEventMap[K]) => void | Promise<void>): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as (payload: never) => void);
    this.listeners.set(event, set);
    return () => set.delete(listener as (payload: never) => void);
  }

  emit<K extends keyof ServerEventMap>(event: K, payload: ServerEventMap[K]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        const result = (listener as (p: ServerEventMap[K]) => void | Promise<void>)(payload);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((err) => this.log?.warn({ err, event }, "event listener failed"));
        }
      } catch (err) {
        this.log?.warn({ err, event }, "event listener failed");
      }
    }
  }
}

/** Background jobs a plugin can schedule. They stop when the server closes. */
export class Jobs {
  private readonly timers = new Set<NodeJS.Timeout>();
  private stopped = false;

  constructor(private readonly log: FastifyBaseLogger) {}

  /**
   * Run `task` every `everyMs` milliseconds (and once shortly after start-up when `runSoon` is set).
   * Runs never overlap and failures are logged, not thrown.
   */
  every(name: string, everyMs: number, task: () => Promise<void> | void, options: { runSoon?: boolean } = {}): void {
    let running = false;
    const tick = async () => {
      if (running || this.stopped) return;
      running = true;
      try {
        await task();
      } catch (err) {
        this.log.warn({ err, job: name }, "background job failed");
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => void tick(), Math.max(1000, everyMs));
    timer.unref();
    this.timers.add(timer);
    if (options.runSoon) {
      const soon = setTimeout(() => void tick(), 2000);
      soon.unref();
      this.timers.add(soon);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) {
      clearInterval(t);
      clearTimeout(t);
    }
    this.timers.clear();
  }
}
