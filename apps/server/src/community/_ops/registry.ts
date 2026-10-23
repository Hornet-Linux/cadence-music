import type { FastifyBaseLogger } from "fastify";
import type { Jobs } from "../../plugins/runtime.js";

/**
 * A tiny registry shared by the operations plugins (metrics reads what the others publish).
 * It lives on globalThis so it is one object even if a module is loaded twice.
 */
export interface JobStat {
  name: string;
  runs: number;
  failures: number;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  lastOk: boolean | null;
  lastError: string | null;
}

export interface MetricSample {
  name: string;
  help: string;
  type: "counter" | "gauge";
  labels?: Record<string, string>;
  value: number;
}

export interface OpsRegistry {
  jobs: Map<string, JobStat>;
  collectors: Map<string, () => MetricSample[]>;
  /** Errors by origin (plugin ids, "http"), counted for the metrics plugin. */
  errors: Map<string, number>;
}

const KEY = Symbol.for("cadence.ops.registry");

export function registry(): OpsRegistry {
  const g = globalThis as unknown as Record<symbol, OpsRegistry | undefined>;
  return (g[KEY] ??= { jobs: new Map(), collectors: new Map(), errors: new Map() });
}

export function countError(origin: string): void {
  const r = registry();
  r.errors.set(origin, (r.errors.get(origin) ?? 0) + 1);
}

/** Let a plugin publish extra metrics; the metrics plugin includes them. Re-registering a key replaces it. */
export function registerCollector(key: string, collect: () => MetricSample[]): void {
  registry().collectors.set(key, collect);
}

const INSTRUMENTED = Symbol.for("cadence.ops.jobs-instrumented");

/**
 * Wrap `jobs.every` so every job scheduled afterwards reports its runs (for /metrics).
 * Safe to call more than once. Jobs scheduled before the first call are not seen.
 */
export function instrumentJobs(jobs: Jobs, log?: FastifyBaseLogger): void {
  const target = jobs as unknown as Record<symbol, boolean> & { every: Jobs["every"] };
  if (target[INSTRUMENTED]) return;
  target[INSTRUMENTED] = true;
  const original = jobs.every.bind(jobs);
  target.every = (name, everyMs, task, options) => {
    const stat: JobStat = { name, runs: 0, failures: 0, lastRunAt: null, lastDurationMs: null, lastOk: null, lastError: null };
    registry().jobs.set(name, stat);
    original(
      name,
      everyMs,
      async () => {
        const started = Date.now();
        stat.lastRunAt = started;
        try {
          await task();
          stat.lastOk = true;
          stat.lastError = null;
        } catch (err) {
          stat.failures += 1;
          stat.lastOk = false;
          stat.lastError = err instanceof Error ? err.message : String(err);
          countError(`job:${name}`);
          throw err;
        } finally {
          stat.runs += 1;
          stat.lastDurationMs = Date.now() - started;
        }
      },
      options,
    );
  };
  log?.debug("background jobs are now reported to the metrics registry");
}
