import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerPluginContext } from "../plugins/types.js";
import { describeFailure, RemoteError, runIndex, type IndexDriver } from "./indexer.js";
import { SourceNetError, type UpstreamResponse } from "./net.js";
import { signedStreamPath, verifySignedStream } from "./signing.js";
import { ensureSourceTables, SourceStore, type CachedTrack, type IndexRun } from "./store.js";
import { sendAudio } from "./stream.js";
import { contentTypeFor } from "./tags.js";

const STREAM_TTL_SEC = 6 * 60 * 60;
const MAX_PAGE = 500;
const ID_RE = /^[0-9a-f]{24}$/;

/** A track as clients see it. Paths and credentials stay on the server. */
export interface SourceTrackDto {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  trackNo: number | null;
  durationSec: number | null;
  /** Where it lives in the remote folder tree (display only). */
  location: string | null;
}

export const toDto = (t: CachedTrack): SourceTrackDto => ({
  id: t.id,
  title: t.title,
  artist: t.artist,
  album: t.album,
  albumArtist: t.albumArtist,
  trackNo: t.trackNo,
  durationSec: t.durationSec,
  location: t.location,
});

export interface IndexingDto {
  running: boolean;
  status: IndexRun["status"] | "never";
  found: number;
  indexed: number;
  removed: number;
  failed: number;
  finishedAt: number | null;
  error: string | null;
}

/** What each kind of source supplies; the runtime does the rest. */
export interface SourceBackend<Conn> {
  /** Routes live under /api/<area>. */
  area: string;
  /** Key for the cache and the signed URLs. */
  source: string;
  /** Name shown in messages, e.g. "WebDAV". */
  label: string;
  /** The plugin id, used to find who has connected (settings.pluginUserConfig). */
  pluginId: string;
  connection(userId: number): Conn | null;
  /** A safe summary of the connection for the status call (never a password or token). */
  describe(userId: number, conn: Conn): Record<string, unknown>;
  driver(userId: number, conn: Conn): IndexDriver;
  open(userId: number, conn: Conn, track: { path: string; size: number }, range: string | undefined, signal: AbortSignal): Promise<UpstreamResponse>;
  /** Remove the person's saved connection. */
  disconnect(userId: number): void;
  /** How often the background job refreshes each person's index. */
  refreshEveryMs?: number;
}

export interface RuntimeOptions {
  streamIdleMs?: number;
  /** Tests make indexing fast. */
  indexBatchSize?: number;
  indexConcurrency?: number;
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (value === undefined || value === "" || !Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** What clients may learn about a failure: fixed phrases, never upstream text or network details. */
export function publicFailure(label: string, area: string, e: unknown): { status: number; body: { error: string; message: string } } {
  const code = (suffix: string) => `${area}_${suffix}`;
  if (e instanceof RemoteError) {
    switch (e.code) {
      case "auth_failed":
        return { status: 502, body: { error: code("auth_failed"), message: `${label} refused the sign-in. Check the details and connect again.` } };
      case "needs_reconnect":
        return { status: 409, body: { error: code("needs_reconnect"), message: `Your ${label} connection expired. Connect again.` } };
      case "not_found":
        return { status: 404, body: { error: "not_found", message: "That file or folder isn't there any more" } };
      case "not_configured":
        return { status: 409, body: { error: code("not_configured"), message: `${label} isn't set up on this server` } };
      default:
        return { status: 502, body: { error: code("failed"), message: `${label} returned an unexpected answer` } };
    }
  }
  if (e instanceof SourceNetError) {
    switch (e.kind) {
      case "invalid_url":
        return { status: 400, body: { error: "invalid_address", message: e.message.replace(/^invalid_url: /, "") } };
      case "blocked":
        return {
          status: 400,
          body: { error: "address_not_allowed", message: "That address isn't allowed. Addresses on private networks need the server owner to allow them." },
        };
      case "insecure":
        return {
          status: 400,
          body: { error: "address_not_allowed", message: "Use an https:// address. Plain http is only accepted for servers on a private network." },
        };
      case "timeout":
        return { status: 504, body: { error: code("failed"), message: `${label} took too long to answer` } };
      case "redirect":
        return { status: 502, body: { error: code("failed"), message: `${label} redirected somewhere that can't be used` } };
      default:
        return { status: 502, body: { error: code("failed"), message: `${label} couldn't be reached. Check the address.` } };
    }
  }
  return { status: 502, body: { error: code("failed"), message: `${label} returned an unexpected answer` } };
}

/**
 * The parts every "music from files elsewhere" plugin shares: the cache of tracks, the background
 * indexer, browsing routes and the Range-aware stream proxy. A plugin supplies a backend (how to
 * list, read and open files) and adds its own routes for connecting.
 */
export class SourceRuntime<Conn> {
  readonly store: SourceStore;
  private readonly running = new Map<number, Promise<IndexRun>>();
  private readonly controllers = new Map<number, AbortController>();
  private readonly stopAll = new AbortController();

  constructor(
    readonly ctx: ServerPluginContext,
    readonly backend: SourceBackend<Conn>,
    private readonly options: RuntimeOptions = {},
  ) {
    ensureSourceTables(ctx.db);
    this.store = new SourceStore(ctx.db, backend.source);
  }

  private nowSec = () => Math.floor(Date.now() / 1000);

  failure(reply: FastifyReply, e: unknown, userId?: number): FastifyReply {
    const f = publicFailure(this.backend.label, this.backend.area, e);
    this.ctx.log.warn({ failure: describeFailure(e), userId }, `${this.backend.label} call failed`);
    return reply.code(f.status).send(f.body);
  }

  indexingState(userId: number): IndexingDto {
    const run = this.store.run(userId);
    const live = this.running.has(userId);
    return {
      running: live,
      status: run ? (live ? "running" : run.status === "running" ? "interrupted" : run.status) : "never",
      found: run?.found ?? 0,
      indexed: run?.indexed ?? 0,
      removed: run?.removed ?? 0,
      failed: run?.failed ?? 0,
      finishedAt: run?.finishedAt ?? null,
      error: run?.error ?? null,
    };
  }

  /** Index one person's remote files, unless that is already happening. */
  index(userId: number): Promise<IndexRun> {
    const existing = this.running.get(userId);
    if (existing) return existing;
    const conn = this.backend.connection(userId);
    if (!conn) return Promise.reject(new RemoteError("not_configured"));
    const ac = new AbortController();
    const stop = () => ac.abort();
    this.stopAll.signal.addEventListener("abort", stop, { once: true });
    this.controllers.set(userId, ac);
    const p = runIndex(this.store, userId, this.backend.driver(userId, conn), {
      signal: ac.signal,
      batchSize: this.options.indexBatchSize,
      concurrency: this.options.indexConcurrency,
    })
      .then((run) => {
        this.ctx.log.info({ userId, status: run.status, found: run.found, indexed: run.indexed, removed: run.removed, failed: run.failed }, `${this.backend.label} index finished`);
        return run;
      })
      .finally(() => {
        this.running.delete(userId);
        this.controllers.delete(userId);
        this.stopAll.signal.removeEventListener("abort", stop);
      });
    this.running.set(userId, p);
    return p;
  }

  /** Stop any running index for this person and start a fresh one (their folders or login changed). */
  async restart(userId: number): Promise<IndexRun> {
    await this.stop(userId);
    return this.index(userId);
  }

  /** Stop this person's indexing, if any, and wait for it to wind down. */
  async stop(userId: number): Promise<void> {
    this.controllers.get(userId)?.abort();
    await this.running.get(userId)?.catch(() => undefined);
  }

  /** People who have saved a connection for this plugin. */
  private connectedUsers(): number[] {
    const prefix = `plugin:${this.backend.pluginId}:user:`;
    const rows = this.ctx.db.prepare("SELECT key FROM settings WHERE key LIKE ? ESCAPE '\\'").all(`${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) as {
      key: string;
    }[];
    return rows.map((r) => Number(r.key.slice(prefix.length))).filter((n) => Number.isInteger(n) && n > 0);
  }

  private dueForRefresh(userId: number): boolean {
    const run = this.store.run(userId);
    if (!run) return true;
    if (run.status === "interrupted" || run.status === "running") return true;
    const every = this.backend.refreshEveryMs ?? 6 * 60 * 60_000;
    const retry = run.status === "failed" ? Math.min(every, 60 * 60_000) : every;
    return (run.finishedAt ?? 0) + retry <= Date.now();
  }

  register(app: FastifyInstance): void {
    const { ctx, backend } = this;
    const { requireUser } = ctx;
    const base = `/api/${backend.area}`;

    this.store.markInterrupted();
    app.addHook("onClose", async () => {
      this.stopAll.abort();
      await Promise.allSettled([...this.running.values()]);
    });
    ctx.jobs.every(
      `${backend.source}-index`,
      10 * 60_000,
      async () => {
        for (const userId of this.connectedUsers()) {
          if (this.stopAll.signal.aborted) return;
          if (!backend.connection(userId) || !this.dueForRefresh(userId)) continue;
          await this.index(userId).catch(() => undefined);
        }
      },
      { runSoon: true },
    );

    app.get(`${base}/status`, { preHandler: requireUser }, async (req) => {
      const userId = req.user!.id;
      const conn = backend.connection(userId);
      return {
        connected: !!conn,
        ...(conn ? backend.describe(userId, conn) : {}),
        trackCount: this.store.count(userId),
        indexing: this.indexingState(userId),
      };
    });

    app.get<{ Querystring: { q?: string; album?: string; artist?: string; limit?: string; offset?: string } }>(
      `${base}/tracks`,
      { preHandler: requireUser },
      async (req) => {
        const q = req.query;
        const page = this.store.list(req.user!.id, {
          q: typeof q.q === "string" && q.q.trim() ? q.q.trim().slice(0, 200) : undefined,
          album: typeof q.album === "string" ? q.album.slice(0, 300) : undefined,
          artist: typeof q.artist === "string" ? q.artist.slice(0, 300) : undefined,
          limit: clampInt(q.limit, 100, 1, MAX_PAGE),
          offset: clampInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER),
        });
        return { items: page.items.map(toDto), total: page.total };
      },
    );

    app.get<{ Querystring: { q?: string; limit?: string; offset?: string } }>(`${base}/albums`, { preHandler: requireUser }, async (req) => {
      const q = req.query;
      return this.store.albums(req.user!.id, {
        q: typeof q.q === "string" && q.q.trim() ? q.q.trim().slice(0, 200) : undefined,
        limit: clampInt(q.limit, 100, 1, MAX_PAGE),
        offset: clampInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER),
      });
    });

    app.get<{ Params: { id: string } }>(`${base}/tracks/:id/stream-url`, { preHandler: requireUser }, async (req, reply) => {
      const userId = req.user!.id;
      if (!ID_RE.test(req.params.id) || !this.store.get(userId, req.params.id)) return reply.code(404).send({ error: "not_found" });
      const expiresAt = this.nowSec() + STREAM_TTL_SEC;
      return { path: signedStreamPath(ctx.secret, backend.area, backend.source, userId, req.params.id, expiresAt), expiresAt };
    });

    app.get<{ Params: { id: string }; Querystring: { u?: string; exp?: string; sig?: string } }>(`${base}/stream/:id`, async (req, reply) => {
      const { id } = req.params;
      const userId = ID_RE.test(id) ? verifySignedStream(ctx.secret, backend.source, id, req.query, this.nowSec()) : null;
      if (userId === null) return reply.code(403).send({ error: "invalid_signature" });
      const track = this.store.get(userId, id);
      const conn = backend.connection(userId);
      if (!track || !conn) return reply.code(404).send({ error: "not_found" });
      const abort = new AbortController();
      try {
        const upstream = await backend.open(userId, conn, track, req.headers.range, abort.signal);
        if (upstream.status === 404 || upstream.status === 410) {
          upstream.body.destroy();
          return reply.code(404).send({ error: "not_found" });
        }
        if (upstream.status === 401 || upstream.status === 403) {
          upstream.body.destroy();
          return this.failure(reply, new RemoteError("auth_failed"), userId);
        }
        if (upstream.status !== 200 && upstream.status !== 206 && upstream.status !== 416) {
          upstream.body.destroy();
          return this.failure(reply, new RemoteError("upstream", undefined, upstream.status), userId);
        }
        return sendAudio(reply, upstream, {
          contentType: contentTypeFor(track.location ?? track.path),
          knownSize: track.size,
          range: req.headers.range,
          idleMs: this.options.streamIdleMs ?? 30_000,
          abort,
        });
      } catch (e) {
        abort.abort();
        return this.failure(reply, e, userId);
      }
    });

    app.post<{ Querystring: { wait?: string } }>(`${base}/index`, { preHandler: requireUser }, async (req, reply) => {
      const userId = req.user!.id;
      if (!backend.connection(userId)) return reply.code(409).send({ error: `${backend.area}_not_connected`, message: `Connect ${backend.label} first` });
      const job = this.index(userId);
      if (req.query.wait === "1") {
        await job.catch(() => undefined);
        return { started: true, indexing: this.indexingState(userId), trackCount: this.store.count(userId) };
      }
      job.catch(() => undefined);
      return reply.code(202).send({ started: true });
    });

    app.delete(`${base}/connection`, { preHandler: requireUser }, async (req, reply) => {
      const userId = req.user!.id;
      // Stop any indexing first, so it can't put rows back after they are cleared.
      await this.stop(userId);
      backend.disconnect(userId);
      this.store.clear(userId);
      return reply.code(204).send();
    });
  }
}
