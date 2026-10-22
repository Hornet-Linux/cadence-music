import { monitorEventLoopDelay } from "node:perf_hooks";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { userForToken } from "../../auth/sessions.js";
import { IDLE_LIMIT_MS } from "../../auth/sessions.js";
import type { ServerPluginContext } from "../../plugins/types.js";
import { SERVER_VERSION } from "../../version.js";
import { randomToken, safeEqual } from "../../util/crypto.js";
import type { ConfigField, DescribedPlugin } from "../_ops/meta.js";
import { instrumentJobs, registry } from "../_ops/registry.js";
import { hasSecret, openSecret, sealSecret } from "../_ops/secrets.js";
import { CounterVec, Histogram, render, type Family } from "./exposition.js";

export const PLUGIN_ID = "cadence.metrics";
const MAX_SERIES = 1000;

interface StoredConfig {
  /** Sealed bearer token for Prometheus. */
  token?: string;
}

const configFields: ConfigField[] = [
  { key: "token", label: "Scrape token", type: "secret", help: "Prometheus sends it as 'Authorization: Bearer <token>'. A signed-in admin's session token also works. METRICS_TOKEN in the environment overrides it." },
];

export interface MetricsOptions {
  now?: () => number;
}

export function createMetricsPlugin(options: MetricsOptions = {}): DescribedPlugin {
  return {
    id: PLUGIN_ID,
    name: "Prometheus metrics",
    version: "1.0.0",
    description:
      "Serves /metrics in the Prometheus text format: request counts and latencies per route, sessions, library size, background jobs, plugin errors and process statistics. Needs a bearer token or an admin session.",
    configFields,
    adminRoutes: ["GET /metrics", "GET /api/metrics/config", "POST /api/metrics/token", "DELETE /api/metrics/token"],
    register(app, ctx) {
      registerMetrics(app, ctx, options);
    },
  };
}

function registerMetrics(app: FastifyInstance, ctx: ServerPluginContext, options: MetricsOptions): void {
  const { db, settings, requireAdmin, secret } = ctx;
  const now = options.now ?? Date.now;
  instrumentJobs(ctx.jobs, ctx.log);

  const requests = new CounterVec("cadence_http_requests_total", "HTTP requests by method, route pattern and status code.");
  const latency = new Histogram("cadence_http_request_duration_seconds", "Time to answer HTTP requests, by method and route pattern.");
  const serverErrors = new CounterVec("cadence_http_server_errors_total", "Responses with a 5xx status, by route pattern.");
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  app.addHook("onClose", async () => loop.disable());
  const startedAt = now();
  let manualScan: { seconds: number; at: number } | null = null;

  const routeOf = (req: FastifyRequest): string => req.routeOptions?.url ?? "unmatched";

  app.addHook("onResponse", async (req, reply) => {
    const route = routeOf(req);
    const seconds = reply.elapsedTime / 1000;
    // Bounded label space: a flood of odd paths must not grow memory.
    const labelsOk = requests.size < MAX_SERIES && latency.size < MAX_SERIES;
    const labels = labelsOk ? { method: req.method, route } : { method: req.method, route: "other" };
    requests.inc({ ...labels, status: String(reply.statusCode) });
    latency.observe(labels, seconds);
    if (reply.statusCode >= 500) {
      serverErrors.inc({ route: labels.route });
      registry().errors.set("http", (registry().errors.get("http") ?? 0) + 1);
    }
    if (route === "/api/library/scan" && req.method === "POST" && (req.query as { wait?: string })?.wait === "1" && reply.statusCode === 200) {
      manualScan = { seconds, at: now() };
    }
  });

  const scalar = (name: string, help: string, type: "counter" | "gauge", value: number, labels?: Record<string, string>): Family => ({
    name,
    help,
    type,
    samples: [{ labels, value }],
  });
  const count = (sql: string, ...args: (string | number)[]) => (db.prepare(sql).get(...args) as { n: number }).n;

  function collect(): Family[] {
    const t = now();
    const families: Family[] = [
      scalar("cadence_build_info", "Server version (always 1).", "gauge", 1, { version: SERVER_VERSION }),
      scalar("cadence_users", "Accounts on this server.", "gauge", count("SELECT COUNT(*) AS n FROM users")),
      scalar("cadence_sessions", "Stored sign-in sessions that can still be used.", "gauge", count("SELECT COUNT(*) AS n FROM sessions WHERE last_used_at >= ?", t - IDLE_LIMIT_MS)),
      scalar("cadence_active_sessions", "Sessions used in the last 24 hours (the server refreshes a session's last-used time at most once an hour).", "gauge", count("SELECT COUNT(*) AS n FROM sessions WHERE last_used_at >= ?", t - 86_400_000)),
      scalar("cadence_library_tracks", "Tracks in the server library.", "gauge", count("SELECT COUNT(*) AS n FROM tracks")),
      scalar("cadence_library_size_bytes", "Size of all library files.", "gauge", count("SELECT COALESCE(SUM(size), 0) AS n FROM tracks")),
      scalar("cadence_library_last_added_timestamp_seconds", "When the newest track was added by a scan.", "gauge", Math.floor(count("SELECT COALESCE(MAX(added_at), 0) AS n FROM tracks") / 1000)),
      scalar("cadence_plays", "Plays in everyone's history.", "gauge", count("SELECT COUNT(*) AS n FROM plays")),
      scalar("cadence_plays_last_24h", "Plays recorded with a start time in the last 24 hours.", "gauge", count("SELECT COUNT(*) AS n FROM plays WHERE played_at >= ?", t - 86_400_000)),
      requests.family(),
      latency.family(),
      serverErrors.family(),
    ];
    if (manualScan) {
      families.push(
        scalar("cadence_library_manual_scan_duration_seconds", "Duration of the last manual rescan that waited for the result (the library plugin does not publish scheduled scan times).", "gauge", manualScan.seconds),
        scalar("cadence_library_manual_scan_timestamp_seconds", "When that manual rescan finished.", "gauge", Math.floor(manualScan.at / 1000)),
      );
    }

    // Plugins: which community plugins are switched on.
    const enabled = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'plugin:%:enabled'").all() as unknown as { key: string; value: string }[];
    families.push({
      name: "cadence_plugin_enabled",
      help: "1 when an admin switched the community plugin on.",
      type: "gauge",
      samples: enabled.map((r) => ({ labels: { plugin: r.key.slice("plugin:".length, -":enabled".length) }, value: r.value === "true" ? 1 : 0 })),
    });
    const errors = registry().errors;
    families.push({
      name: "cadence_plugin_errors_total",
      help: "Errors by origin: a plugin id, job:<name>, or http for 5xx responses.",
      type: "counter",
      samples: [...errors].map(([origin, value]) => ({ labels: { origin }, value })),
    });

    // Background jobs (those scheduled after the first operations plugin loaded).
    const jobs = [...registry().jobs.values()];
    const perJob = (name: string, help: string, type: "counter" | "gauge", pick: (j: (typeof jobs)[number]) => number | null): Family => ({
      name,
      help,
      type,
      samples: jobs.flatMap((j) => {
        const v = pick(j);
        return v === null ? [] : [{ labels: { job: j.name }, value: v }];
      }),
    });
    families.push(
      perJob("cadence_job_runs_total", "Runs of a background job.", "counter", (j) => j.runs),
      perJob("cadence_job_failures_total", "Failed runs of a background job.", "counter", (j) => j.failures),
      perJob("cadence_job_last_run_timestamp_seconds", "Start of the job's last run.", "gauge", (j) => (j.lastRunAt ? Math.floor(j.lastRunAt / 1000) : null)),
      perJob("cadence_job_last_duration_seconds", "Duration of the job's last run.", "gauge", (j) => (j.lastDurationMs === null ? null : j.lastDurationMs / 1000)),
      perJob("cadence_job_last_run_ok", "1 if the job's last run succeeded, 0 if it failed.", "gauge", (j) => (j.lastOk === null ? null : j.lastOk ? 1 : 0)),
    );

    // Extra metrics published by other plugins.
    for (const [key, fn] of registry().collectors) {
      try {
        const bySeries = new Map<string, Family>();
        for (const m of fn()) {
          const f = bySeries.get(m.name) ?? { name: m.name, help: m.help, type: m.type, samples: [] };
          f.samples.push({ labels: m.labels, value: m.value });
          bySeries.set(m.name, f);
        }
        families.push(...bySeries.values());
      } catch (err) {
        ctx.log.warn({ err, collector: key }, "a metrics collector failed");
      }
    }

    // The process.
    const cpu = process.cpuUsage();
    const mem = process.memoryUsage();
    families.push(
      scalar("process_cpu_user_seconds_total", "User CPU time spent.", "counter", cpu.user / 1e6),
      scalar("process_cpu_system_seconds_total", "System CPU time spent.", "counter", cpu.system / 1e6),
      scalar("process_resident_memory_bytes", "Resident memory size.", "gauge", mem.rss),
      scalar("process_start_time_seconds", "Start time of the process since the Unix epoch.", "gauge", Math.floor(startedAt / 1000)),
      scalar("process_uptime_seconds", "Seconds the server has been running.", "gauge", Math.floor((t - startedAt) / 1000)),
      scalar("nodejs_heap_used_bytes", "V8 heap in use.", "gauge", mem.heapUsed),
      scalar("nodejs_heap_total_bytes", "V8 heap reserved.", "gauge", mem.heapTotal),
      scalar("nodejs_external_memory_bytes", "Memory held by C++ objects bound to JavaScript.", "gauge", mem.external),
      scalar("nodejs_eventloop_lag_mean_seconds", "Mean event loop delay since start.", "gauge", Number.isFinite(loop.mean) ? loop.mean / 1e9 : 0),
      scalar("nodejs_eventloop_lag_p99_seconds", "99th percentile event loop delay since start.", "gauge", loop.percentile(99) / 1e9),
      scalar("nodejs_active_resources", "Active handles and requests.", "gauge", process.getActiveResourcesInfo().length),
      scalar("nodejs_version_info", "Node.js version (always 1).", "gauge", 1, { version: process.version }),
    );
    return families;
  }

  const readToken = (): string | null => {
    if (process.env.METRICS_TOKEN) return process.env.METRICS_TOKEN;
    return openSecret(settings.pluginConfig<StoredConfig>(PLUGIN_ID)?.token, secret, PLUGIN_ID);
  };

  app.get("/metrics", async (req, reply) => {
    const header = req.headers.authorization ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const token = readToken();
    let allowed = Boolean(bearer && token && safeEqual(bearer, token));
    if (!allowed && bearer) allowed = userForToken(db, bearer)?.is_admin === 1;
    if (!allowed) return reply.code(401).header("WWW-Authenticate", 'Bearer realm="cadence-metrics"').send({ error: "unauthorized" });
    return reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8").header("Cache-Control", "no-store").send(render(collect()));
  });

  app.get("/api/metrics/config", { preHandler: requireAdmin }, async () => ({
    tokenSet: Boolean(process.env.METRICS_TOKEN) || hasSecret(settings.pluginConfig<StoredConfig>(PLUGIN_ID)?.token),
    tokenFromEnvironment: Boolean(process.env.METRICS_TOKEN),
    path: "/metrics",
  }));

  // The token is shown once, when it is made.
  app.post("/api/metrics/token", { preHandler: requireAdmin }, async (req) => {
    const token = randomToken(24);
    settings.setPluginConfig(PLUGIN_ID, { token: sealSecret(token, secret, PLUGIN_ID) } satisfies StoredConfig);
    req.log.info({ admin: req.user!.username }, "admin made a new metrics token");
    return { token };
  });

  app.delete("/api/metrics/token", { preHandler: requireAdmin }, async (_req, reply) => {
    settings.setPluginConfig(PLUGIN_ID, null);
    return reply.code(204).send();
  });
}

export default createMetricsPlugin();