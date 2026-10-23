import { pipeline, Transform, type TransformCallback } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { NetResponse } from "./http.js";

/**
 * Passes bytes through, and gives up when the source goes quiet while the consumer wants more.
 * (A consumer that is simply paused, such as a player with a full buffer, is not "quiet".)
 */
export class IdleGuard extends Transform {
  private timer: NodeJS.Timeout | undefined;
  constructor(
    private readonly ms: number,
    private readonly onIdle: () => void,
  ) {
    super();
  }
  override _read(size: number): void {
    if (this.ms > 0) this.timer ??= setTimeout(this.onIdle, this.ms);
    super._read(size);
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.disarm();
    cb(null, chunk);
  }
  override _flush(cb: TransformCallback): void {
    this.disarm();
    cb();
  }
  override _destroy(err: Error | null, cb: (error?: Error | null) => void): void {
    this.disarm();
    cb(err);
  }
  private disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

const SINGLE_RANGE = /^bytes=\d*-\d*$/;

/** The request's Range header when it is a single plain byte range, else undefined (it is never forwarded otherwise). */
export function singleRange(req: FastifyRequest): string | undefined {
  const range = req.headers.range?.trim();
  return range && range.length < 64 && SINGLE_RANGE.test(range) && range !== "bytes=-" ? range : undefined;
}

export interface ProxyOptions {
  /** Content types worth passing on. Anything else is a 502 (never relay a page or script). */
  accept: RegExp;
  cache: string;
  idleMs: number;
  /** Replace the upstream content type (e.g. a safe image type). */
  contentType?: string;
  /** Headers added to the answer. */
  extraHeaders?: Record<string, string>;
  /** Sits between upstream and client (live radio strips ICY metadata here). */
  transform?: (res: NetResponse) => Transform | null;
  /** Whether to relay length and range headers (not for transformed live streams). */
  relayRange?: boolean;
  /** Called when the answer has been decided, before bytes flow. */
  onStart?: (res: NetResponse, type: string) => void;
  /** Called when the transfer ends, for whatever reason. */
  onEnd?: () => void;
}

/**
 * Sends an upstream response to the client without buffering. Closing either end tears the other down,
 * including the connection to the origin. Status and headers are filtered: only fixed, safe ones go out.
 */
export function proxyResponse(req: FastifyRequest, reply: FastifyReply, res: NetResponse, opts: ProxyOptions): FastifyReply {
  const drop = () => {
    res.abort();
    opts.onEnd?.();
  };
  if (res.status === 404 || res.status === 410) {
    drop();
    return reply.code(404).send({ error: "not_found" });
  }
  if (res.status === 416) {
    drop();
    const range = res.headers["content-range"];
    return reply.code(416).header("Content-Range", typeof range === "string" && /^bytes \*\/\d+$/.test(range) ? range : "bytes */0").send();
  }
  const type = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if ((res.status !== 200 && res.status !== 206) || !opts.accept.test(type)) {
    req.log.warn({ status: res.status, type }, "upstream returned something unplayable");
    drop();
    return reply.code(502).send({ error: "upstream_failed", message: "The source returned an unexpected answer" });
  }
  opts.onStart?.(res, type);
  const transform = opts.transform?.(res) ?? null;
  reply.code(res.status).header("Content-Type", opts.contentType ?? type).header("Cache-Control", opts.cache);
  if (opts.relayRange !== false) {
    for (const name of ["content-length", "content-range", "accept-ranges"]) {
      const value = res.headers[name];
      if (typeof value === "string" && /^[\w ,*/=-]{1,100}$/.test(value)) reply.header(name, value);
    }
  }
  for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) reply.header(k, v);
  const guard = new IdleGuard(opts.idleMs, () => guard.destroy(new Error("source stopped sending data")));
  const chain = transform ? [res.body, transform, guard] : [res.body, guard];
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    res.abort();
    opts.onEnd?.();
  };
  pipeline(chain as never, () => done());
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) {
      guard.destroy();
      res.body.destroy();
    }
    done();
  });
  return reply.send(guard);
}

/** Fixed, harmless phrases for upstream failures. */
export function netFailureMessage(kind: string): { error: string; message: string } {
  if (kind === "blocked") return { error: "address_not_allowed", message: "That address isn't allowed" };
  if (kind === "timeout") return { error: "upstream_failed", message: "The source took too long to answer" };
  if (kind === "too_large") return { error: "too_large", message: "That is too large to load" };
  if (kind === "redirect") return { error: "upstream_failed", message: "The source redirected somewhere that isn't allowed" };
  return { error: "upstream_failed", message: "The source couldn't be reached" };
}