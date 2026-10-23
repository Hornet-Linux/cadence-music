/**
 * Prometheus text exposition format, version 0.0.4
 * (https://prometheus.io/docs/instrumenting/exposition_formats/). The format is simple enough that
 * no client library is needed.
 */

export type MetricType = "counter" | "gauge" | "histogram";

export interface Sample {
  /** Defaults to the family name; histograms add _bucket, _sum and _count. */
  name?: string;
  labels?: Record<string, string>;
  value: number;
}

export interface Family {
  name: string;
  help: string;
  type: MetricType;
  samples: Sample[];
}

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export const escapeLabelValue = (v: string): string => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
export const escapeHelp = (v: string): string => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");

export function formatValue(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "+Inf";
  if (v === -Infinity) return "-Inf";
  return String(v);
}

function labelString(labels: Record<string, string> | undefined): string {
  const entries = Object.entries(labels ?? {});
  if (entries.length === 0) return "";
  return `{${entries
    .map(([k, v]) => {
      if (!LABEL_RE.test(k) || k.startsWith("__")) throw new Error(`invalid metric label name: ${k}`);
      return `${k}="${escapeLabelValue(String(v))}"`;
    })
    .join(",")}}`;
}

/** Render families to the text format. Families with the same name are merged (their samples are concatenated). */
export function render(families: Family[]): string {
  const merged = new Map<string, Family>();
  for (const f of families) {
    const existing = merged.get(f.name);
    if (existing) existing.samples.push(...f.samples);
    else merged.set(f.name, { ...f, samples: [...f.samples] });
  }
  const lines: string[] = [];
  for (const f of merged.values()) {
    if (!NAME_RE.test(f.name)) throw new Error(`invalid metric name: ${f.name}`);
    if (f.samples.length === 0) continue;
    lines.push(`# HELP ${f.name} ${escapeHelp(f.help)}`, `# TYPE ${f.name} ${f.type}`);
    for (const s of f.samples) {
      const name = s.name ?? f.name;
      if (!NAME_RE.test(name)) throw new Error(`invalid metric name: ${name}`);
      lines.push(`${name}${labelString(s.labels)} ${formatValue(s.value)}`);
    }
  }
  return lines.join("\n") + "\n";
}

export const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 120];

/** A set of histograms sharing a name and buckets, one per label combination. */
export class Histogram {
  private readonly series = new Map<string, { labels: Record<string, string>; counts: number[]; sum: number; count: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: number[] = HTTP_BUCKETS,
  ) {}

  observe(labels: Record<string, string>, value: number): void {
    const key = JSON.stringify(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels, counts: new Array<number>(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    this.buckets.forEach((le, i) => {
      if (value <= le) s.counts[i] += 1;
    });
    s.sum += value;
    s.count += 1;
  }

  get size(): number {
    return this.series.size;
  }

  family(): Family {
    const samples: Sample[] = [];
    for (const s of this.series.values()) {
      this.buckets.forEach((le, i) => samples.push({ name: `${this.name}_bucket`, labels: { ...s.labels, le: String(le) }, value: s.counts[i] }));
      samples.push({ name: `${this.name}_bucket`, labels: { ...s.labels, le: "+Inf" }, value: s.count });
      samples.push({ name: `${this.name}_sum`, labels: s.labels, value: s.sum });
      samples.push({ name: `${this.name}_count`, labels: s.labels, value: s.count });
    }
    return { name: this.name, help: this.help, type: "histogram", samples };
  }
}

/** Counters keyed by label set. */
export class CounterVec {
  private readonly series = new Map<string, { labels: Record<string, string>; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Record<string, string>, by = 1): void {
    const key = JSON.stringify(labels);
    const s = this.series.get(key);
    if (s) s.value += by;
    else this.series.set(key, { labels, value: by });
  }

  get size(): number {
    return this.series.size;
  }

  family(): Family {
    return { name: this.name, help: this.help, type: "counter", samples: [...this.series.values()].map((s) => ({ labels: s.labels, value: s.value })) };
  }
}