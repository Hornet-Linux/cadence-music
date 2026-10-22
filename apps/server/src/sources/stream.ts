import { pipeline, Readable, Transform, type TransformCallback } from "node:stream";
import type { FastifyReply } from "fastify";
import type { UpstreamResponse } from "./net.js";

/**
 * Passes bytes through, and gives up when the source goes quiet while the consumer
 * wants more. (A consumer that is simply paused is not "quiet".)
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
    this.timer ??= setTimeout(this.onIdle, this.ms);
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

/** Skips `skip` bytes and then passes at most `take` bytes (for servers that ignore Range). */
async function* sliceBody(body: Readable, skip: number, take: number): AsyncGenerator<Buffer> {
  let seen = 0;
  let sent = 0;
  for await (const raw of body) {
    const chunk = raw as Buffer;
    const from = skip - seen;
    seen += chunk.length;
    let out = chunk;
    if (from > 0) out = from >= chunk.length ? chunk.subarray(0, 0) : chunk.subarray(from);
    if (out.length > take - sent) out = out.subarray(0, take - sent);
    if (out.length) {
      sent += out.length;
      yield out;
    }
    if (sent >= take) return; // leaving the loop closes the upstream body
  }
}

export interface ByteRange {
  start: number;
  end: number;
}

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * Parses a single `Range: bytes=...` header against a known size.
 * Returns null for no (or unusable multi-range) header, "unsatisfiable" when it lies outside the file.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = SINGLE_RANGE.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || start > end || start >= size) return "unsatisfiable";
  return { start, end };
}

export interface ProxyOptions {
  contentType: string;
  /** Size recorded when the file was indexed, used when the server ignores Range. */
  knownSize: number | null;
  /** The client's raw Range header. */
  range: string | undefined;
  idleMs: number;
  /** Called to cancel the upstream request when the client goes away. */
  abort: AbortController;
}

/**
 * Sends an upstream audio response to the client without buffering it. Handles servers that
 * answer a Range request with the whole file (200) by cutting the range out ourselves.
 */
export function sendAudio(reply: FastifyReply, upstream: UpstreamResponse, opts: ProxyOptions): FastifyReply {
  const { headers } = upstream;
  const len = (v: string | string[] | undefined) => {
    const n = Number(Array.isArray(v) ? v[0] : v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  reply.header("Accept-Ranges", "bytes").header("Content-Type", opts.contentType).header("Cache-Control", "private, max-age=3600");
  if (headers.etag) reply.header("ETag", String(headers.etag));

  let source: Readable = upstream.body;
  const wanted = opts.range && SINGLE_RANGE.test(opts.range.trim()) ? opts.range : undefined;

  if (upstream.status === 416) {
    upstream.body.destroy();
    const total = typeof headers["content-range"] === "string" ? /\/(\d+)$/.exec(headers["content-range"])?.[1] : undefined;
    return reply.code(416).header("Content-Range", `bytes */${total ?? opts.knownSize ?? 0}`).send();
  }

  if (upstream.status === 206) {
    const cr = typeof headers["content-range"] === "string" ? headers["content-range"] : undefined;
    reply.code(206);
    if (cr) reply.header("Content-Range", cr);
    const cl = len(headers["content-length"]);
    if (cl !== null) reply.header("Content-Length", cl);
  } else if (upstream.status === 200 && wanted) {
    // The server ignored the Range header: cut the requested part out of the full body.
    const size = len(headers["content-length"]) ?? opts.knownSize;
    if (size === null) {
      const cl = len(headers["content-length"]);
      if (cl !== null) reply.header("Content-Length", cl);
    } else {
      const r = parseRange(wanted, size);
      if (r === "unsatisfiable") {
        upstream.body.destroy();
        return reply.code(416).header("Content-Range", `bytes */${size}`).send();
      }
      if (r) {
        source = Readable.from(sliceBody(upstream.body, r.start, r.end - r.start + 1), { objectMode: false });
        reply
          .code(206)
          .header("Content-Range", `bytes ${r.start}-${r.end}/${size}`)
          .header("Content-Length", r.end - r.start + 1);
      }
    }
  } else {
    const cl = len(headers["content-length"]);
    if (cl !== null) reply.header("Content-Length", cl);
  }

  const guard = new IdleGuard(opts.idleMs, () => guard.destroy(new Error("upstream idle")));
  const body = pipeline(source, guard, () => undefined);
  const stop = () => {
    opts.abort.abort();
    upstream.body.destroy();
    body.destroy();
  };
  reply.raw.once("close", () => {
    if (!reply.raw.writableEnded) stop();
  });
  return reply.send(body);
}
