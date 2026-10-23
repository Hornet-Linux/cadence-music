import dgram from "node:dgram";

/** A DNS question for `name` with the given type. QU is set so devices may answer by unicast. */
export function buildQuery(name: string, type: number): Buffer {
  const labels = name.split(".").filter(Boolean);
  const parts: Buffer[] = [Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0])];
  for (const l of labels) parts.push(Buffer.from([l.length]), Buffer.from(l));
  const tail = Buffer.alloc(5);
  tail.writeUInt16BE(type, 1);
  tail.writeUInt16BE(0x8001, 3);
  parts.push(tail);
  return Buffer.concat(parts);
}

export interface DnsRecord {
  name: string;
  type: number;
  data: Buffer;
  /** Offset of `data` within the packet (names inside records can point back into the packet). */
  offset: number;
}

export function readName(buf: Buffer, start: number): { name: string; next: number } {
  const labels: string[] = [];
  let i = start;
  let next = -1;
  for (let hops = 0; hops < 64; hops++) {
    const len = buf[i];
    if (len === undefined) throw new Error("bad name");
    if (len === 0) {
      if (next < 0) next = i + 1;
      return { name: labels.join("."), next };
    }
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | (buf[i + 1] ?? 0);
      if (next < 0) next = i + 2;
      i = ptr;
      continue;
    }
    labels.push(buf.subarray(i + 1, i + 1 + len).toString("utf8"));
    i += 1 + len;
  }
  throw new Error("name loop");
}

export function parseRecords(buf: Buffer): DnsRecord[] {
  if (buf.length < 12) return [];
  const qd = buf.readUInt16BE(4);
  const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let i = 12;
  try {
    for (let q = 0; q < qd; q++) i = readName(buf, i).next + 4;
    const out: DnsRecord[] = [];
    for (let r = 0; r < total; r++) {
      const { name, next } = readName(buf, i);
      const type = buf.readUInt16BE(next);
      const len = buf.readUInt16BE(next + 8);
      const offset = next + 10;
      out.push({ name, type, data: buf.subarray(offset, offset + len), offset });
      i = offset + len;
    }
    return out;
  } catch {
    return [];
  }
}

export interface CastService {
  /** TXT "id": the device's unique id. */
  id: string;
  /** TXT "fn": the name people gave it. */
  name: string;
  /** TXT "md": the model, e.g. "Chromecast Ultra". */
  model?: string;
  host: string;
  port: number;
}

function parseTxt(data: Buffer): Record<string, string> {
  const kv: Record<string, string> = {};
  let p = 0;
  while (p < data.length) {
    const l = data[p]!;
    const entry = data.subarray(p + 1, p + 1 + l).toString("utf8");
    const eq = entry.indexOf("=");
    if (eq > 0) kv[entry.slice(0, eq)] = entry.slice(eq + 1);
    p += 1 + l;
  }
  return kv;
}

/** Turn the records of one or more mDNS answers into Google Cast devices. */
export function castServicesFrom(packets: Buffer[]): CastService[] {
  const ptr = new Set<string>();
  const srv = new Map<string, { port: number; target: string }>();
  const txt = new Map<string, Record<string, string>>();
  const addr = new Map<string, string>();
  for (const buf of packets) {
    for (const rec of parseRecords(buf)) {
      try {
        if (rec.type === 12 && rec.name.toLowerCase() === "_googlecast._tcp.local") ptr.add(readName(buf, rec.offset).name);
        else if (rec.type === 33 && rec.data.length >= 7)
          srv.set(rec.name, { port: rec.data.readUInt16BE(4), target: readName(buf, rec.offset + 6).name });
        else if (rec.type === 16) txt.set(rec.name, parseTxt(rec.data));
        else if (rec.type === 1 && rec.data.length === 4) addr.set(rec.name, [...rec.data].join("."));
      } catch {
        // skip a malformed record
      }
    }
  }
  const out: CastService[] = [];
  for (const instance of ptr) {
    const s = srv.get(instance);
    const kv = txt.get(instance) ?? {};
    const host = s ? addr.get(s.target) : undefined;
    if (!s || !host) continue;
    out.push({ id: kv["id"] ?? instance, name: kv["fn"] ?? instance.split("._googlecast")[0] ?? host, model: kv["md"], host, port: s.port });
  }
  return out;
}

export interface MdnsOptions {
  timeoutMs?: number;
  target?: { address: string; port: number };
  interfaces?: string[];
}

/** Ask the network for Chromecasts and collect the answers. */
export function discoverCasts(opts: MdnsOptions = {}): Promise<CastService[]> {
  const target = opts.target ?? { address: "224.0.0.251", port: 5353 };
  const query = buildQuery("_googlecast._tcp.local", 12);
  const interfaces: (string | undefined)[] = opts.interfaces && opts.interfaces.length > 0 ? opts.interfaces : [undefined];
  return new Promise((resolve) => {
    const packets: Buffer[] = [];
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(castServicesFrom(packets));
    };
    socket.on("error", finish);
    socket.on("message", (data) => packets.push(Buffer.from(data)));
    socket.bind(0, () => {
      const send = () => {
        for (const iface of interfaces) {
          try {
            if (iface) socket.setMulticastInterface(iface);
            socket.send(query, target.port, target.address, () => undefined);
          } catch {
            // skip this network
          }
        }
      };
      send();
      setTimeout(() => !done && send(), 500).unref();
    });
    setTimeout(finish, opts.timeoutMs ?? 2500).unref();
  });
}
