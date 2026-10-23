/**
 * The CASTV2 wire format: a 4-byte big-endian length followed by a protobuf `CastMessage`. Only that one message
 * type is needed, so it is encoded by hand instead of pulling in a protobuf library.
 *
 *   message CastMessage {
 *     required ProtocolVersion protocol_version = 1;  // CASTV2_1_0 = 0
 *     required string source_id = 2;
 *     required string destination_id = 3;
 *     required string namespace = 4;
 *     required PayloadType payload_type = 5;          // STRING = 0, BINARY = 1
 *     optional string payload_utf8 = 6;
 *     optional bytes payload_binary = 7;
 *   }
 */
export interface CastMessage {
  sourceId: string;
  destinationId: string;
  namespace: string;
  /** Present for STRING payloads (all that this client uses). */
  payload?: string;
  binary?: Buffer;
}

export const MAX_FRAME = 1024 * 1024;

function varint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
}

function field(num: number, wire: 0 | 2, body: Buffer | number): Buffer {
  const tag = varint((num << 3) | wire);
  if (wire === 0) return Buffer.concat([tag, varint(body as number)]);
  const data = body as Buffer;
  return Buffer.concat([tag, varint(data.length), data]);
}

export function encodeCastMessage(m: CastMessage): Buffer {
  const parts = [
    field(1, 0, 0),
    field(2, 2, Buffer.from(m.sourceId)),
    field(3, 2, Buffer.from(m.destinationId)),
    field(4, 2, Buffer.from(m.namespace)),
    field(5, 0, m.binary ? 1 : 0),
  ];
  if (m.binary) parts.push(field(7, 2, m.binary));
  else parts.push(field(6, 2, Buffer.from(m.payload ?? "")));
  return Buffer.concat(parts);
}

/** Frame a message for the socket. */
export function frame(m: CastMessage): Buffer {
  const body = encodeCastMessage(m);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

export function decodeCastMessage(buf: Buffer): CastMessage {
  const m: CastMessage = { sourceId: "", destinationId: "", namespace: "" };
  let i = 0;
  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (i >= buf.length) throw new Error("truncated varint");
      const b = buf[i++]!;
      result += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return result;
      shift += 7;
      if (shift > 49) throw new Error("varint too long");
    }
  };
  while (i < buf.length) {
    const tag = readVarint();
    const num = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) {
      readVarint();
    } else if (wire === 2) {
      const len = readVarint();
      if (i + len > buf.length) throw new Error("truncated field");
      const data = buf.subarray(i, i + len);
      i += len;
      if (num === 2) m.sourceId = data.toString("utf8");
      else if (num === 3) m.destinationId = data.toString("utf8");
      else if (num === 4) m.namespace = data.toString("utf8");
      else if (num === 6) m.payload = data.toString("utf8");
      else if (num === 7) m.binary = Buffer.from(data);
    } else if (wire === 1) {
      i += 8;
    } else if (wire === 5) {
      i += 4;
    } else {
      throw new Error("unsupported wire type");
    }
  }
  return m;
}

/** Splits a TCP byte stream into messages. */
export class FrameReader {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): CastMessage[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: CastMessage[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > MAX_FRAME) throw new Error("cast frame too large");
      if (this.buf.length < 4 + len) break;
      out.push(decodeCastMessage(this.buf.subarray(4, 4 + len)));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}
