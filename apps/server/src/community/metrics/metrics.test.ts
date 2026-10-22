import assert from "node:assert/strict";
import test from "node:test";
import { libraryPlugin } from "../../library/plugin.js";
import { makeApp } from "../_ops/testkit.js";
import { createQuotasPlugin } from "../quotas-audit/plugin.js";
import { createWebhooksPlugin } from "../webhooks/plugin.js";
import { CounterVec, Histogram, escapeHelp, escapeLabelValue, formatValue, render } from "./exposition.js";
import { createMetricsPlugin } from "./plugin.js";

interface ParsedSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** A strict reader of the Prometheus text format; throws on anything a real Prometheus would reject. */
export function parseExposition(text: string): { samples: ParsedSample[]; types: Map<string, string>; helps: Map<string, string> } {
  assert.ok(text.endsWith("\n"), "must end with a newline");
  const types = new Map<string, string>();
  const helps = new Map<string, string>();
  const samples: ParsedSample[] = [];
  const closed = new Set<string>();
  let current: string | null = null;
  const baseOf = (name: string): string => {
    for (const suffix of ["_bucket", "_sum", "_count"]) {
      if (name.endsWith(suffix) && types.get(name.slice(0, -suffix.length)) === "histogram") return name.slice(0, -suffix.length);
    }
    return name;
  };
  for (const line of text.trimEnd().split("\n")) {
    assert.ok(line.length > 0, "no blank lines");
    const help = /^# HELP ([a-zA-Z_:][a-zA-Z0-9_:]*) (.*)$/.exec(line);
    if (help) {
      assert.ok(!helps.has(help[1]), `duplicate HELP for ${help[1]}`);
      helps.set(help[1], help[2]);
      continue;
    }
    const type = /^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*) (counter|gauge|histogram|summary|untyped)$/.exec(line);
    if (type) {
      assert.ok(!types.has(type[1]), `duplicate TYPE for ${type[1]}`);
      types.set(type[1], type[2]);
      continue;
    }
    assert.ok(!line.startsWith("#"), `unknown comment: ${line}`);
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
    assert.ok(m, `not a sample line: ${line}`);
    const labels: Record<string, string> = {};
    if (m[2]) {
      const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"(?:,|$)/g;
      let consumed = 0;
      for (const l of m[2].matchAll(re)) {
        labels[l[1]] = l[2].replace(/\\(["\\n])/g, (_x, c: string) => (c === "n" ? "\n" : c));
        consumed += l[0].length;
      }
      assert.equal(consumed, m[2].length, `bad labels: ${m[2]}`);
    }
    const value = m[3] === "+Inf" ? Infinity : m[3] === "-Inf" ? -Infinity : m[3] === "NaN" ? NaN : Number(m[3]);
    assert.ok(!Number.isNaN(value) || m[3] === "NaN", `bad value: ${m[3]}`);
    const family = baseOf(m[1]);
    assert.ok(types.has(family), `sample ${m[1]} before its TYPE`);
    assert.ok(helps.has(family), `sample ${m[1]} has no HELP`);
    if (family !== current) {
      assert.ok(!closed.has(family), `samples of ${family} are not contiguous`);
      if (current) closed.add(current);
      current = family;
    }
    samples.push({ name: m[1], labels, value });
  }
  // Histograms: cumulative buckets, +Inf equals the count.
  for (const [name, type] of types) {
    if (type !== "histogram") continue;
    const series = new Map<string, ParsedSample[]>();
    for (const s of samples.filter((x) => x.name.startsWith(name))) {
      const rest = { ...s.labels };
      delete rest.le;
      const key = JSON.stringify(rest);
      series.set(key, [...(series.get(key) ?? []), s]);
    }
    for (const list of series.values()) {
      const buckets = list.filter((s) => s.name === `${name}_bucket`);
      const les = buckets.map((b) => (b.labels.le === "+Inf" ? Infinity : Number(b.labels.le)));
      assert.deepEqual(les, [...les].sort((a, b) => a - b), "le ascending");
      assert.equal(les[les.length - 1], Infinity, "last bucket is +Inf");
      buckets.forEach((b, i) => i > 0 && assert.ok(b.value >= buckets[i - 1].value, "buckets are cumulative"));
      const count = list.find((s) => s.name === `${name}_count`)!;
      assert.equal(buckets[buckets.length - 1].value, count.value, "+Inf bucket equals count");
      assert.ok(list.some((s) => s.name === `${name}_sum`));
    }
  }
  return { samples, types, helps };
}

const find = (samples: ParsedSample[], name: string, labels: Record<string, string> = {}) =>
  samples.find((s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v));

test("label values and help text are escaped the way Prometheus expects", () => {
  assert.equal(escapeLabelValue('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
  assert.equal(escapeHelp("line\nbreak \\ "), "line\\nbreak \\\\ ");
  assert.equal(formatValue(Infinity), "+Inf");
  assert.equal(formatValue(NaN), "NaN");
  assert.equal(formatValue(1.5e-7), "1.5e-7");
  const text = render([{ name: "x_total", help: "Help\nwith newline", type: "counter", samples: [{ labels: { path: 'a"\\\n' }, value: 3 }] }]);
  const parsed = parseExposition(text);
  assert.equal(parsed.samples[0].labels.path, 'a"\\\n');
});

test("invalid metric and label names are refused instead of producing a broken page", () => {
  assert.throws(() => render([{ name: "bad-name", help: "h", type: "gauge", samples: [{ value: 1 }] }]));
  assert.throws(() => render([{ name: "ok", help: "h", type: "gauge", samples: [{ labels: { "bad label": "x" }, value: 1 }] }]));
  assert.throws(() => render([{ name: "ok", help: "h", type: "gauge", samples: [{ labels: { __reserved: "x" }, value: 1 }] }]));
  assert.equal(render([{ name: "empty", help: "h", type: "gauge", samples: [] }]), "\n");
});

test("histograms are cumulative and counters add up", () => {
  const h = new Histogram("lat_seconds", "Latency.", [0.1, 1]);
  for (const v of [0.05, 0.5, 0.5, 5]) h.observe({ route: "/a" }, v);
  h.observe({ route: "/b" }, 0.01);
  const c = new CounterVec("hits_total", "Hits.");
  c.inc({ route: "/a" });
  c.inc({ route: "/a" }, 2);
  const parsed = parseExposition(render([h.family(), c.family()]));
  assert.equal(find(parsed.samples, "lat_seconds_bucket", { route: "/a", le: "0.1" })!.value, 1);
  assert.equal(find(parsed.samples, "lat_seconds_bucket", { route: "/a", le: "1" })!.value, 3);
  assert.equal(find(parsed.samples, "lat_seconds_bucket", { route: "/a", le: "+Inf" })!.value, 4);
  assert.equal(find(parsed.samples, "lat_seconds_sum", { route: "/a" })!.value, 6.05);
  assert.equal(find(parsed.samples, "hits_total", { route: "/a" })!.value, 3);
});

test("/metrics: needs a token or an admin, and the page is valid, complete exposition text", async () => {
  const t = await makeApp([libraryPlugin, createWebhooksPlugin(), createQuotasPlugin(), createMetricsPlugin()]);
  try {
    const admin = t.auth(t.adminToken);
    assert.equal((await t.app.inject({ method: "GET", url: "/metrics" })).statusCode, 401);
    assert.equal((await t.app.inject({ method: "GET", url: "/metrics", headers: t.auth(t.userToken) })).statusCode, 401);
    assert.equal((await t.app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer nope" } })).statusCode, 401);
    assert.equal((await t.app.inject({ method: "GET", url: "/api/metrics/config", headers: t.auth(t.userToken) })).statusCode, 403);

    // A scrape token, shown once and kept sealed.
    assert.equal(((await t.app.inject({ method: "GET", url: "/api/metrics/config", headers: admin })).json() as { tokenSet: boolean }).tokenSet, false);
    const { token } = (await t.app.inject({ method: "POST", url: "/api/metrics/token", headers: admin })).json() as { token: string };
    assert.ok(token.length >= 24);
    const stored = (t.db.prepare("SELECT value FROM settings WHERE key = 'plugin:cadence.metrics:config'").get() as { value: string }).value;
    assert.ok(!stored.includes(token));
    assert.equal(((await t.app.inject({ method: "GET", url: "/api/metrics/config", headers: admin })).json() as { tokenSet: boolean }).tokenSet, true);

    // Some traffic to count.
    for (let i = 0; i < 3; i++) await t.app.inject({ method: "GET", url: "/api/health" });
    await t.app.inject({ method: "GET", url: "/api/nothing-here" });
    await t.app.inject({ method: "POST", url: "/api/library/scan?wait=1", headers: admin });

    const res = await t.app.inject({ method: "GET", url: "/metrics", headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] as string, /^text\/plain; version=0\.0\.4/);
    const { samples, types } = parseExposition(res.body);

    assert.equal(find(samples, "cadence_http_requests_total", { method: "GET", route: "/api/health", status: "200" })!.value, 3);
    assert.equal(find(samples, "cadence_http_requests_total", { route: "unmatched", status: "404" })!.value, 1, "unknown paths share one label");
    assert.ok(find(samples, "cadence_http_request_duration_seconds_count", { route: "/api/health" })!.value >= 3);
    assert.equal(types.get("cadence_http_request_duration_seconds"), "histogram");
    assert.equal(find(samples, "cadence_users")!.value, 2);
    assert.equal(find(samples, "cadence_sessions")!.value, 2);
    assert.equal(find(samples, "cadence_library_tracks")!.value, 0);
    assert.ok(find(samples, "cadence_library_manual_scan_duration_seconds"));
    assert.equal(find(samples, "cadence_build_info")!.labels.version.length > 0, true);
    for (const name of ["process_resident_memory_bytes", "process_cpu_user_seconds_total", "process_start_time_seconds", "nodejs_heap_used_bytes", "nodejs_eventloop_lag_p99_seconds", "process_uptime_seconds"]) {
      assert.ok(find(samples, name), name);
    }
    // Other plugins publish through the registry; jobs are listed by name.
    assert.ok(find(samples, "cadence_webhook_deliveries", { status: "pending" }));
    assert.ok(find(samples, "cadence_quota_denied_total", { reason: "daily" }));
    assert.ok(find(samples, "cadence_job_runs_total", { job: "webhooks-deliver" }));
    assert.ok(find(samples, "cadence_plugin_errors_total") === undefined || find(samples, "cadence_plugin_errors_total")!.value >= 0);

    // An admin session works too (handy in a browser or with curl while testing).
    assert.equal((await t.app.inject({ method: "GET", url: "/metrics", headers: admin })).statusCode, 200);
    // Removing the token locks scrapers out again.
    assert.equal((await t.app.inject({ method: "DELETE", url: "/api/metrics/token", headers: admin })).statusCode, 204);
    assert.equal((await t.app.inject({ method: "GET", url: "/metrics", headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
  } finally {
    await t.cleanup();
  }
});

test("the 5xx counter and the error total move when a route fails", async () => {
  const t2 = await makeApp([
    {
      id: "test.boom",
      name: "boom",
      version: "1",
      register(app) {
        app.get("/boom", async () => {
          throw new Error("boom");
        });
      },
    },
    createMetricsPlugin(),
  ]);
  try {
    assert.equal((await t2.app.inject({ method: "GET", url: "/boom" })).statusCode, 500);
    const { samples } = parseExposition((await t2.app.inject({ method: "GET", url: "/metrics", headers: t2.auth(t2.adminToken) })).body);
    assert.equal(find(samples, "cadence_http_server_errors_total", { route: "/boom" })!.value, 1);
    assert.equal(find(samples, "cadence_plugin_errors_total", { origin: "http" })!.value, 1);
  } finally {
    await t2.cleanup();
  }
});