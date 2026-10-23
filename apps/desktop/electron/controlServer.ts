import crypto from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";

// A tiny local control API for Stream Deck, scripts and other tools.
//
//   GET  /v1/state                 now-playing snapshot
//   GET  /v1/commands              command names this app can run
//   GET|POST /v1/command/<name>    run a command (?value=0.5 or a JSON body for arguments)
//   WS   /v1/ws                    live state, and {"command":"next"} messages
//
// It binds to 127.0.0.1 only, needs a secret token on every request and refuses
// requests that look like a web page talking to it (Origin header) or that
// arrive under another host name (DNS rebinding). No dependencies: the few
// bytes of WebSocket framing a text-only API needs are written out below.

export const COMMAND_NAME_RE = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;
const MAX_BODY = 8 * 1024;
const MAX_WS_MESSAGE = 16 * 1024;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function generateToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** Constant-time token check (hashing first makes the lengths equal). */
export function tokenMatches(expected: string, given: string | null | undefined): boolean {
  if (!given || !expected) return false;
  const a = crypto.createHash("sha256").update(expected).digest();
  const b = crypto.createHash("sha256").update(given).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Pull the token out of an Authorization header or a ?token= query parameter. */
export function tokenFromRequest(headers: http.IncomingHttpHeaders, url: URL): string | null {
  const auth = headers.authorization;
  if (typeof auth === "string" && /^bearer /i.test(auth)) return auth.slice(7).trim();
  return url.searchParams.get("token");
}

const LOCAL_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/** Browsers always send Origin on cross-site requests; scripts and Stream Deck don't. */
export function requestIsLocalAndDirect(headers: http.IncomingHttpHeaders): boolean {
  const host = headers.host;
  if (typeof host !== "string" || !LOCAL_HOST_RE.test(host)) return false;
  return headers.origin === undefined;
}

export interface ControlHandlers {
  /** Run a command in the app. Reject with an Error whose message is shown to the caller. */
  run: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  state: () => unknown;
  commands: () => string[];
}

export interface ControlOptions {
  port: number;
  token: string;
  handlers: ControlHandlers;
}

export class ControlError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Arguments for a command from the query string: ?value=0.5&amount=2 become numbers when numeric. */
export function argsFromQuery(url: URL): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if (key === "token") continue;
    const n = Number(value);
    args[key] = value.trim() !== "" && Number.isFinite(n) ? n : value;
  }
  return args;
}

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// ---- WebSocket framing (server side, text frames only) ----------------------

export function wsAcceptKey(clientKey: string): string {
  return crypto.createHash("sha1").update(clientKey + WS_GUID).digest("base64");
}

export function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

export interface WsFrame {
  opcode: number;
  payload: Buffer;
}

/** Reads masked client frames out of a byte stream. Fragmented messages are joined. */
export class WsDecoder {
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;

  push(chunk: Buffer): WsFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const out: WsFrame[] = [];
    for (;;) {
      if (this.buffer.length < 2) break;
      const b0 = this.buffer[0]!;
      const b1 = this.buffer[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      if ((b0 & 0x70) !== 0) throw new Error("Unsupported WebSocket extension");
      if ((b1 & 0x80) === 0) throw new Error("Client frames must be masked");
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) break;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) break;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_WS_MESSAGE)) throw new Error("WebSocket message too large");
        length = Number(big);
        offset = 10;
      }
      if (length > MAX_WS_MESSAGE) throw new Error("WebSocket message too large");
      if (this.buffer.length < offset + 4 + length) break;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
      this.buffer = this.buffer.subarray(offset + 4 + length);

      if (opcode >= 0x8) {
        // Control frames are never fragmented.
        out.push({ opcode, payload });
        continue;
      }
      if (opcode !== 0) {
        this.fragments = [];
        this.fragmentOpcode = opcode;
      }
      this.fragments.push(payload);
      if (this.fragments.reduce((n, p) => n + p.length, 0) > MAX_WS_MESSAGE) throw new Error("WebSocket message too large");
      if (fin) {
        out.push({ opcode: this.fragmentOpcode, payload: Buffer.concat(this.fragments) });
        this.fragments = [];
      }
    }
    return out;
  }
}

export interface ControlStatus {
  running: boolean;
  port: number | null;
  error?: string;
  clients: number;
}

/** Failed sign-ins are slowed down: after this many in a minute, requests get 429. */
const MAX_FAILURES = 20;
const FAILURE_WINDOW_MS = 60_000;

export class ControlServer {
  private server: http.Server | null = null;
  private sockets = new Set<Duplex>();
  private wsClients = new Set<Duplex>();
  private failures: number[] = [];
  private lastStateJson = "";
  port: number | null = null;

  constructor(private readonly options: ControlOptions) {}

  get clients(): number {
    return this.wsClients.size;
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => void this.onRequest(req, res));
      server.on("upgrade", (req, socket) => this.onUpgrade(req, socket));
      server.on("connection", (socket) => {
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
      });
      server.once("error", reject);
      // 127.0.0.1 only: never reachable from another machine.
      server.listen(this.options.port, "127.0.0.1", () => {
        server.off("error", reject);
        this.server = server;
        const address = server.address();
        this.port = typeof address === "object" && address ? address.port : this.options.port;
        resolve(this.port);
      });
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.wsClients.clear();
    return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }

  /** Tell WebSocket listeners the state changed (cheap when nothing changed). */
  broadcastState(): void {
    if (this.wsClients.size === 0) return;
    const json = JSON.stringify({ type: "state", state: this.options.handlers.state() });
    if (json === this.lastStateJson) return;
    this.lastStateJson = json;
    const frame = encodeWsFrame(0x1, Buffer.from(json));
    for (const c of this.wsClients) c.write(frame);
  }

  private tooManyFailures(now: number): boolean {
    this.failures = this.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
    return this.failures.length >= MAX_FAILURES;
  }

  /** Common checks for HTTP and WebSocket: local host, no Origin, valid token. Returns an HTTP status or 0. */
  private reject(req: http.IncomingMessage, url: URL): number {
    if (!requestIsLocalAndDirect(req.headers)) return 403;
    const now = Date.now();
    if (this.tooManyFailures(now)) return 429;
    if (!tokenMatches(this.options.token, tokenFromRequest(req.headers, url))) {
      this.failures.push(now);
      return 401;
    }
    return 0;
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      const json = JSON.stringify(body);
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-length": Buffer.byteLength(json),
      });
      res.end(json);
    };
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const denied = this.reject(req, url);
      if (denied) return send(denied, { ok: false, error: denied === 401 ? "unauthorized" : denied === 429 ? "too_many_attempts" : "forbidden" });

      const path = url.pathname.replace(/\/+$/, "");
      if (path === "/v1/state" && req.method === "GET") return send(200, { ok: true, state: this.options.handlers.state() });
      if (path === "/v1/commands" && req.method === "GET") return send(200, { ok: true, commands: this.options.handlers.commands() });

      const match = /^\/v1\/command\/([^/]+)$/.exec(path);
      if (match && (req.method === "GET" || req.method === "POST")) {
        const name = decodeURIComponent(match[1]!);
        if (!COMMAND_NAME_RE.test(name)) return send(400, { ok: false, error: "bad_command_name" });
        const args = { ...argsFromQuery(url), ...plainObject(req.method === "POST" ? await readJson(req) : null) };
        const result = await this.options.handlers.run(name, args);
        return send(200, { ok: true, result: result ?? null });
      }
      return send(404, { ok: false, error: "not_found" });
    } catch (err) {
      if (err instanceof ControlError) return send(err.status, { ok: false, error: err.message });
      return send(500, { ok: false, error: "failed" });
    }
  }

  private onUpgrade(req: http.IncomingMessage, socket: Duplex): void {
    const refuse = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const key = req.headers["sec-websocket-key"];
    if (url.pathname.replace(/\/+$/, "") !== "/v1/ws" || typeof key !== "string" || req.headers.upgrade?.toLowerCase() !== "websocket") {
      return refuse(404, "Not Found");
    }
    const denied = this.reject(req, url);
    if (denied) return refuse(denied, denied === 401 ? "Unauthorized" : denied === 429 ? "Too Many Requests" : "Forbidden");
    if (this.wsClients.size >= 8) return refuse(503, "Service Unavailable");

    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAcceptKey(key)}\r\n\r\n`,
    );
    this.wsClients.add(socket);
    const decoder = new WsDecoder();
    const sendJson = (value: unknown) => socket.write(encodeWsFrame(0x1, Buffer.from(JSON.stringify(value))));
    const drop = () => {
      this.wsClients.delete(socket);
      socket.destroy();
    };
    socket.on("close", () => this.wsClients.delete(socket));
    socket.on("error", drop);
    socket.on("data", (chunk: Buffer) => {
      let frames: WsFrame[];
      try {
        frames = decoder.push(chunk);
      } catch {
        socket.write(encodeWsFrame(0x8, Buffer.from([0x03, 0xf0]))); // 1008 policy violation
        return drop();
      }
      for (const frame of frames) {
        if (frame.opcode === 0x8) {
          socket.write(encodeWsFrame(0x8, frame.payload.subarray(0, 2)));
          return drop();
        }
        if (frame.opcode === 0x9) socket.write(encodeWsFrame(0xa, frame.payload));
        else if (frame.opcode === 0x1) void this.onWsMessage(frame.payload.toString("utf8"), sendJson);
      }
    });
    sendJson({ type: "state", state: this.options.handlers.state() });
  }

  private async onWsMessage(text: string, send: (value: unknown) => void): Promise<void> {
    let msg: { id?: unknown; command?: unknown; args?: unknown };
    try {
      msg = plainObject(JSON.parse(text));
    } catch {
      return send({ ok: false, error: "bad_json" });
    }
    const id = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : undefined;
    if (typeof msg.command !== "string" || !COMMAND_NAME_RE.test(msg.command)) {
      return send({ id, ok: false, error: "bad_command_name" });
    }
    try {
      const result = await this.options.handlers.run(msg.command, plainObject(msg.args));
      send({ id, ok: true, result: result ?? null });
    } catch (err) {
      send({ id, ok: false, error: err instanceof ControlError ? err.message : "failed" });
    }
  }
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ControlError("body_too_large", 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (size === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ControlError("bad_json", 400));
      }
    });
    req.on("error", reject);
  });
}