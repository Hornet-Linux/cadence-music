import { randomUUID } from "node:crypto";
import type { Db } from "../../db.js";
import { countError } from "../_ops/registry.js";
import { UrlRejected, safeRequest, type SafeRequestOptions, type SafeResponse } from "../_ops/ssrf.js";
import { renderBody, signatureHeader, type Envelope, type TemplateId } from "./templates.js";

/** An endpoint with its secret already decrypted. */
export interface ResolvedEndpoint {
  id: string;
  name: string;
  url: string;
  secret: string;
  events: string[];
  template: TemplateId;
  enabled: boolean;
  allowPrivate: boolean;
}

export type RequestFn = (url: string, options: SafeRequestOptions) => Promise<SafeResponse>;

export interface AttemptLog {
  at: number;
  status: number | null;
  error: string | null;
  ms: number;
}

export interface DeliveryRow {
  id: string;
  endpointId: string;
  endpointName: string;
  event: string;
  status: "pending" | "success" | "failed";
  attempts: number;
  nextAttemptAt: number | null;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  log: AttemptLog[];
}

/** Waits between attempts: after the 1st failure, the 2nd, and so on. The delivery is given up after the last. */
export const DEFAULT_BACKOFF_MS = [10_000, 60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
const MAX_PENDING_PER_ENDPOINT = 1000;
const KEEP_ROWS = 1000;
const KEEP_MS = 14 * 86_400_000;

interface RawRow {
  id: string;
  endpoint_id: string;
  endpoint_name: string;
  event: string;
  payload: string;
  status: DeliveryRow["status"];
  attempts: number;
  next_attempt_at: number | null;
  last_status: number | null;
  last_error: string | null;
  attempt_log: string;
  created_at: number;
  updated_at: number;
}

export interface EngineOptions {
  db: Db;
  endpoints: () => ResolvedEndpoint[];
  request?: RequestFn;
  now?: () => number;
  backoffMs?: number[];
  onError?: (err: unknown) => void;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL,
    endpoint_name TEXT NOT NULL,
    event TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    last_status INTEGER,
    last_error TEXT,
    attempt_log TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries (status, next_attempt_at);
  CREATE INDEX IF NOT EXISTS webhook_deliveries_time ON webhook_deliveries (created_at DESC);
`;

/**
 * Queues events for the configured endpoints, sends them signed, retries failures with
 * backoff and keeps a delivery log. The queue is a table, so retries survive a restart.
 */
export class WebhookEngine {
  private readonly db: Db;
  private readonly endpoints: () => ResolvedEndpoint[];
  private readonly request: RequestFn;
  private readonly now: () => number;
  private readonly backoff: number[];
  private readonly onError: ((err: unknown) => void) | undefined;
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(options: EngineOptions) {
    this.db = options.db;
    this.endpoints = options.endpoints;
    this.request = options.request ?? safeRequest;
    this.now = options.now ?? Date.now;
    this.backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.onError = options.onError;
    this.db.exec(SCHEMA);
  }

  private fail(err: unknown): void {
    countError("cadence.webhooks");
    this.onError?.(err);
  }

  /** Queue `event` for every enabled endpoint that wants it, and start sending. Returns the delivery ids. */
  emit(event: string, data: Record<string, unknown>, onlyEndpoint?: string): string[] {
    const ids: string[] = [];
    const createdAt = this.now();
    for (const endpoint of this.endpoints()) {
      if (onlyEndpoint ? endpoint.id !== onlyEndpoint : !endpoint.enabled || !endpoint.events.includes(event)) continue;
      const pending = (
        this.db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE endpoint_id = ? AND status = 'pending'").get(endpoint.id) as { n: number }
      ).n;
      if (pending >= MAX_PENDING_PER_ENDPOINT) {
        this.fail(new Error(`webhook queue for ${endpoint.name} is full; event dropped`));
        continue;
      }
      const envelope: Envelope = { id: randomUUID(), event, createdAt: new Date(createdAt).toISOString(), data };
      this.db
        .prepare(
          `INSERT INTO webhook_deliveries (id, endpoint_id, endpoint_name, event, payload, status, attempts, next_attempt_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
        )
        .run(envelope.id, endpoint.id, endpoint.name, event, JSON.stringify(envelope), createdAt, createdAt, createdAt);
      ids.push(envelope.id);
      void this.attemptById(envelope.id).catch((err) => this.fail(err));
    }
    return ids;
  }

  /** Send everything that is due (call this from a job every few seconds). */
  async tick(): Promise<number> {
    const due = this.db
      .prepare("SELECT id FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 25")
      .all(this.now()) as unknown as { id: string }[];
    await Promise.all(due.map((d) => this.attemptById(d.id).catch((err) => this.fail(err))));
    this.prune();
    return due.length;
  }

  /** Try one delivery now. Resolves once the attempt is recorded. */
  async attemptById(id: string): Promise<DeliveryRow | null> {
    const running = this.inFlight.get(id);
    if (running) {
      await running;
      return this.get(id);
    }
    const row = this.raw(id);
    if (!row || row.status !== "pending") return row ? toDelivery(row) : null;
    const attempt = this.attempt(row).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, attempt);
    await attempt;
    return this.get(id);
  }

  private async attempt(row: RawRow): Promise<void> {
    const endpoint = this.endpoints().find((e) => e.id === row.endpoint_id);
    const started = this.now();
    let status: number | null = null;
    let error: string | null = null;
    let permanent = false;

    if (!endpoint) {
      error = "The endpoint was removed.";
      permanent = true;
    } else if (!endpoint.enabled && row.event !== "webhook.test") {
      error = "The endpoint is switched off.";
      permanent = true;
    } else {
      const envelope = JSON.parse(row.payload) as Envelope;
      const body = renderBody(endpoint.template, envelope);
      const timestamp = Math.floor(started / 1000);
      try {
        const res = await this.request(endpoint.url, {
          method: "POST",
          body,
          allowPrivate: endpoint.allowPrivate,
          timeoutMs: 10_000,
          headers: {
            "content-type": "application/json",
            "user-agent": "Cadence-Webhooks/1",
            "x-cadence-event": row.event,
            "x-cadence-delivery": row.id,
            "x-cadence-timestamp": String(timestamp),
            "x-cadence-signature": signatureHeader(endpoint.secret, timestamp, body),
          },
        });
        status = res.status;
        if (res.status < 200 || res.status >= 300) {
          error = `The receiver answered ${res.status}.`;
          // A 4xx means the receiver refused this request; sending it again will not change that.
          permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 425 && res.status !== 429;
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        permanent = err instanceof UrlRejected;
      }
    }

    const attempts = row.attempts + 1;
    const log = [...(JSON.parse(row.attempt_log) as AttemptLog[]), { at: started, status, error, ms: this.now() - started }].slice(-8);
    const now = this.now();
    let nextStatus: DeliveryRow["status"];
    let next: number | null = null;
    if (!error) nextStatus = "success";
    else if (permanent || attempts > this.backoff.length) nextStatus = "failed";
    else {
      nextStatus = "pending";
      next = now + this.backoff[attempts - 1];
    }
    if (nextStatus === "failed") countError("cadence.webhooks");
    this.db
      .prepare(
        `UPDATE webhook_deliveries SET status = ?, attempts = ?, next_attempt_at = ?, last_status = ?, last_error = ?, attempt_log = ?, updated_at = ? WHERE id = ?`,
      )
      .run(nextStatus, attempts, next, status, error, JSON.stringify(log), now, row.id);
  }

  /** Put a finished delivery back in the queue (the admin pressed Retry). */
  retry(id: string): boolean {
    const row = this.raw(id);
    if (!row || row.status === "pending") return false;
    const now = this.now();
    this.db.prepare("UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL, updated_at = ? WHERE id = ?").run(now, now, id);
    void this.attemptById(id).catch((err) => this.fail(err));
    return true;
  }

  private raw(id: string): RawRow | null {
    return (this.db.prepare("SELECT * FROM webhook_deliveries WHERE id = ?").get(id) as unknown as RawRow | undefined) ?? null;
  }

  get(id: string): DeliveryRow | null {
    const row = this.raw(id);
    return row ? toDelivery(row) : null;
  }

  list(limit = 100, endpointId?: string): DeliveryRow[] {
    const rows = (
      endpointId
        ? this.db.prepare("SELECT * FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(endpointId, limit)
        : this.db.prepare("SELECT * FROM webhook_deliveries ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit)
    ) as unknown as RawRow[];
    return rows.map(toDelivery);
  }

  counts(): { pending: number; failed: number; success: number } {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM webhook_deliveries GROUP BY status").all() as unknown as { status: string; n: number }[];
    const out = { pending: 0, failed: 0, success: 0 };
    for (const r of rows) if (r.status in out) out[r.status as keyof typeof out] = r.n;
    return out;
  }

  /** Drop old finished deliveries so the log stays small. */
  prune(): void {
    this.db.prepare("DELETE FROM webhook_deliveries WHERE status != 'pending' AND updated_at < ?").run(this.now() - KEEP_MS);
    this.db
      .prepare(
        `DELETE FROM webhook_deliveries WHERE status != 'pending' AND rowid NOT IN
           (SELECT rowid FROM webhook_deliveries ORDER BY created_at DESC LIMIT ?)`,
      )
      .run(KEEP_ROWS);
  }
}

function toDelivery(r: RawRow): DeliveryRow {
  let log: AttemptLog[] = [];
  try {
    log = JSON.parse(r.attempt_log) as AttemptLog[];
  } catch {
    // keep the row visible
  }
  return {
    id: r.id,
    endpointId: r.endpoint_id,
    endpointName: r.endpoint_name,
    event: r.event,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    lastStatus: r.last_status,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    log,
  };
}
