import { Transform, type TransformCallback } from "node:stream";

/** Largest metadata interval we trust. Real servers use 8192 or 16000; anything wild means "don't parse". */
const MAX_METAINT = 262_144;

/** Turns the raw ICY metadata block into a station "now playing" line, or null when it has none. */
export function parseStreamTitle(block: Buffer): string | null {
  let text = block.toString("utf8");
  if (text.includes("\ufffd")) text = block.toString("latin1");
  text = text.replace(/\0+$/, "");
  const m = /StreamTitle='(.*?)'\s*(?:;|$)/s.exec(text);
  if (!m) return null;
  // eslint-disable-next-line no-control-regex
  const title = m[1].replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return title || null;
}

/** Reads the ICY metaint header value. */
export function metaInterval(header: string | string[] | undefined): number | null {
  const n = Number(Array.isArray(header) ? header[0] : header);
  return Number.isInteger(n) && n > 0 && n <= MAX_METAINT ? n : null;
}

/**
 * Removes the in-band metadata an Icecast/Shoutcast server mixes into the audio when asked with
 * "Icy-MetaData: 1" (a length byte and a text block after every `metaint` bytes of audio), so the player gets
 * plain audio, and reports each new StreamTitle.
 */
export class IcyStripper extends Transform {
  private remaining: number;
  private state: "audio" | "length" | "meta" = "audio";
  private metaLeft = 0;
  private meta: Buffer[] = [];
  private last: string | null | undefined;

  constructor(
    private readonly metaint: number,
    private readonly onTitle: (title: string | null) => void,
  ) {
    super();
    this.remaining = metaint;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    const out: Buffer[] = [];
    let i = 0;
    while (i < chunk.length) {
      if (this.state === "audio") {
        const take = Math.min(this.remaining, chunk.length - i);
        out.push(chunk.subarray(i, i + take));
        i += take;
        this.remaining -= take;
        if (this.remaining === 0) this.state = "length";
      } else if (this.state === "length") {
        this.metaLeft = chunk[i++] * 16;
        this.meta = [];
        if (this.metaLeft === 0) {
          this.state = "audio";
          this.remaining = this.metaint;
        } else this.state = "meta";
      } else {
        const take = Math.min(this.metaLeft, chunk.length - i);
        this.meta.push(chunk.subarray(i, i + take));
        i += take;
        this.metaLeft -= take;
        if (this.metaLeft === 0) {
          const title = parseStreamTitle(Buffer.concat(this.meta));
          if (title !== this.last) {
            this.last = title;
            this.onTitle(title);
          }
          this.state = "audio";
          this.remaining = this.metaint;
        }
      }
    }
    cb(null, out.length === 1 ? out[0] : Buffer.concat(out));
  }
}