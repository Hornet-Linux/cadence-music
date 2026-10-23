import { pipeline, Readable, Transform, type TransformCallback } from "node:stream";
import type { FastifyReply } from "fastify";

/**
 * Passes bytes through, and gives up when the source goes quiet while the
 * consumer wants more. (A consumer that is simply paused is not "quiet".)
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

/** Fails the stream when more than `max` bytes pass. */
class ByteCap extends Transform {
  private seen = 0;
  constructor(private readonly max: number) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.seen += chunk.length;
    if (this.seen > this.max) return cb(new Error("response too large"));
    cb(null, chunk);
  }
}

export const SINGLE_RANGE = /^bytes=\d*-\d*$/;
export const AUDIO_TYPE = /^(audio\/[\w.+-]+|application\/ogg)$/i;
export const IMAGE_TYPE = /^image\/(jpeg|png|webp|gif|avif|bmp)$/i;

/** A validated single Range header value, or undefined. */
export function cleanRange(value: string | undefined): string | undefined {
  const range = value?.trim();
  return range && SINGLE_RANGE.test(range) ? range : undefined;
}

export interface PipeOptions {
  cache: string;
  idleMs: number;
  /** Refuse (before sending) or cut off bodies larger than this. */
  maxBytes?: number;
}

/**
 * Sends an upstream body to the client without buffering it, keeps only the
 * headers a player needs, and cancels upstream when the client leaves.
 * The caller has already checked status and content type.
 */
export function pipeUpstream(
  reply: FastifyReply,
  res: Response,
  type: string,
  ac: AbortController,
  opts: PipeOptions,
  tooLarge: () => FastifyReply,
): FastifyReply {
  const length = Number(res.headers.get("content-length"));
  if (opts.maxBytes !== undefined && Number.isFinite(length) && length > opts.maxBytes) {
    void res.body?.cancel().catch(() => undefined);
    return tooLarge();
  }
  reply.code(res.status).header("Content-Type", type).header("Cache-Control", opts.cache);
  for (const name of ["content-length", "content-range", "accept-ranges"]) {
    const value = res.headers.get(name);
    if (value && /^[\w ,*/=-]{1,100}$/.test(value)) reply.header(name, value);
  }
  const source = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
  const guard = new IdleGuard(opts.idleMs, () => guard.destroy(new Error("upstream stopped sending data")));
  const stages: (Readable | Transform)[] = [source, guard];
  if (opts.maxBytes !== undefined) stages.push(new ByteCap(opts.maxBytes));
  const last = stages[stages.length - 1];
  // Closing either end tears the whole chain down, including the request upstream.
  pipeline(stages as [Readable, Transform], () => {
    if (!source.readableEnded) ac.abort();
  });
  return reply.send(last);
}