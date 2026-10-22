// @vitest-environment node
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  ControlError,
  ControlServer,
  WsDecoder,
  argsFromQuery,
  encodeWsFrame,
  requestIsLocalAndDirect,
  tokenFromRequest,
  tokenMatches,
  wsAcceptKey,
} from "./controlServer";

const TOKEN = "t".repeat(32);

describe("token checks", () => {
  it("matches only the exact token", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(TOKEN, TOKEN + "x")).toBe(false);
    expect(tokenMatches(TOKEN, "")).toBe(false);
    expect(tokenMatches(TOKEN, null)).toBe(false);
    expect(tokenMatches("", "")).toBe(false);
  });
  it("reads the token from a bearer header or the query string", () => {
    expect(tokenFromRequest({ authorization: "Bearer abc" }, new URL("http://x/v1/state"))).toBe("abc");
    expect(tokenFromRequest({ authorization: "bearer abc" }, new URL("http://x/v1/state"))).toBe("abc");
    expect(tokenFromRequest({}, new URL("http://x/v1/state?token=q"))).toBe("q");
    expect(tokenFromRequest({}, new URL("http://x/v1/state"))).toBeNull();
  });
  it("only accepts local host names and no Origin", () => {
    expect(requestIsLocalAndDirect({ host: "127.0.0.1:47321" })).toBe(true);
    expect(requestIsLocalAndDirect({ host: "localhost:1" })).toBe(true);
    expect(requestIsLocalAndDirect({ host: "[::1]:1" })).toBe(true);
    expect(requestIsLocalAndDirect({ host: "evil.example.com:47321" })).toBe(false); // DNS rebinding
    expect(requestIsLocalAndDirect({ host: "127.0.0.1:1", origin: "https://evil.example.com" })).toBe(false);
    expect(requestIsLocalAndDirect({})).toBe(false);
  });
  it("turns numeric query values into numbers and drops the token", () => {
    expect(argsFromQuery(new URL("http://x/c?token=s&value=0.5&mode=loud&empty="))).toEqual({ value: 0.5, mode: "loud", empty: "" });
  });
});

describe("websocket framing", () => {
  function maskedFrame(opcode: number, payload: Buffer, fin = true): Buffer {
    const mask = crypto.randomBytes(4);
    const body = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!));
    let header: Buffer;
    if (payload.length < 126) header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length]);
    else {
      header = Buffer.alloc(4);
      header[0] = (fin ? 0x80 : 0) | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    }
    return Buffer.concat([header, mask, body]);
  }

  it("computes the RFC 6455 accept key", () => {
    expect(wsAcceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });
  it("decodes masked text frames, including one split across chunks and a medium-length one", () => {
    const decoder = new WsDecoder();
    const f = maskedFrame(1, Buffer.from('{"command":"next"}'));
    expect(decoder.push(f.subarray(0, 3))).toEqual([]);
    const [frame] = decoder.push(f.subarray(3));
    expect(frame!.payload.toString()).toBe('{"command":"next"}');
    const big = Buffer.from("a".repeat(300));
    expect(decoder.push(maskedFrame(1, big))[0]!.payload.length).toBe(300);
  });
  it("joins fragmented messages", () => {
    const decoder = new WsDecoder();
    const out = [
      ...decoder.push(maskedFrame(1, Buffer.from("hel"), false)),
      ...decoder.push(maskedFrame(0, Buffer.from("lo"), true)),
    ];
    expect(out).toHaveLength(1);
    expect(out[0]!.payload.toString()).toBe("hello");
  });
  it("rejects unmasked client frames and oversized messages", () => {
    expect(() => new WsDecoder().push(encodeWsFrame(1, Buffer.from("hi")))).toThrow(/masked/);
    const huge = Buffer.alloc(10);
    huge[0] = 0x81;
    huge[1] = 0x80 | 127;
    huge.writeBigUInt64BE(10_000_000n, 2);
    expect(() => new WsDecoder().push(Buffer.concat([huge, Buffer.alloc(4)]))).toThrow(/large/);
  });
  it("encodes short, medium and long server frames", () => {
    expect(encodeWsFrame(1, Buffer.from("hi"))).toEqual(Buffer.from([0x81, 2, 0x68, 0x69]));
    expect(encodeWsFrame(1, Buffer.alloc(200)).subarray(0, 4)).toEqual(Buffer.from([0x81, 126, 0, 200]));
    expect(encodeWsFrame(1, Buffer.alloc(70000)).readBigUInt64BE(2)).toBe(70000n);
  });
});

// ---- A real server on an ephemeral port ------------------------------------------

let server: ControlServer | null = null;
const ran: { name: string; args: Record<string, unknown> }[] = [];
let state: unknown = { playing: false };

async function boot(): Promise<number> {
  ran.length = 0;
  state = { playing: false };
  server = new ControlServer({
    port: 0,
    token: TOKEN,
    handlers: {
      run: async (name, args) => {
        ran.push({ name, args });
        if (name === "nope") throw new ControlError("unknown_command", 404);
        if (name === "boom") throw new Error("secret internal detail");
        return { done: name };
      },
      state: () => state,
      commands: () => ["next", "volume"],
    },
  });
  return server.start();
}

afterEach(async () => {
  await server?.stop();
  server = null;
});

function request(port: number, opts: { path: string; method?: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: opts.path, method: opts.method ?? "GET", headers: opts.headers },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

const auth = { authorization: `Bearer ${TOKEN}` };

describe("control HTTP API", () => {
  it("binds to the loopback interface only", async () => {
    const port = await boot();
    const addr = (server as unknown as { server: http.Server }).server.address() as net.AddressInfo;
    expect(addr.address).toBe("127.0.0.1");
    expect(port).toBeGreaterThan(0);
  });

  it("refuses requests without or with a wrong token", async () => {
    const port = await boot();
    expect((await request(port, { path: "/v1/state" })).status).toBe(401);
    expect((await request(port, { path: "/v1/state", headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await request(port, { path: "/v1/command/next", method: "POST" })).status).toBe(401);
    expect(ran).toEqual([]);
  });

  it("refuses browser-style requests even with the right token", async () => {
    const port = await boot();
    expect((await request(port, { path: "/v1/state", headers: { ...auth, origin: "https://evil.example.com" } })).status).toBe(403);
    expect((await request(port, { path: "/v1/state", headers: { ...auth, host: "evil.example.com" } })).status).toBe(403);
  });

  it("returns state and commands, and accepts the token in the query", async () => {
    const port = await boot();
    expect((await request(port, { path: "/v1/state", headers: auth })).json).toEqual({ ok: true, state: { playing: false } });
    expect((await request(port, { path: `/v1/commands?token=${TOKEN}` })).json).toEqual({ ok: true, commands: ["next", "volume"] });
  });

  it("runs commands from GET query arguments and POST bodies", async () => {
    const port = await boot();
    const a = await request(port, { path: "/v1/command/volume?value=0.4", headers: auth });
    expect(a.json).toEqual({ ok: true, result: { done: "volume" } });
    await request(port, {
      path: "/v1/command/seek",
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: '{"seconds":30}',
    });
    expect(ran).toEqual([
      { name: "volume", args: { value: 0.4 } },
      { name: "seek", args: { seconds: 30 } },
    ]);
  });

  it("maps errors without leaking internals", async () => {
    const port = await boot();
    expect((await request(port, { path: "/v1/command/nope", headers: auth })).status).toBe(404);
    const boom = await request(port, { path: "/v1/command/boom", headers: auth });
    expect(boom.status).toBe(500);
    expect(JSON.stringify(boom.json)).not.toContain("secret");
    expect((await request(port, { path: "/v1/command/bad%20name", headers: auth })).status).toBe(400);
    expect((await request(port, { path: "/v1/command/x", method: "POST", headers: auth, body: "{oops" })).status).toBe(400);
    expect((await request(port, { path: "/v1/unknown", headers: auth })).status).toBe(404);
  });

  it("slows down guessing", async () => {
    const port = await boot();
    for (let i = 0; i < 20; i++) await request(port, { path: "/v1/state", headers: { authorization: "Bearer wrong" } });
    expect((await request(port, { path: "/v1/state", headers: auth })).status).toBe(429);
  });
});

describe("control WebSocket", () => {
  function connect(port: number, path: string, extraHeaders = ""): Promise<{ socket: net.Socket; head: string }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extraHeaders}\r\n`,
        );
      });
      socket.once("data", (d) => resolve({ socket, head: d.toString("latin1") }));
      socket.on("error", reject);
    });
  }

  function clientFrame(text: string): Buffer {
    const payload = Buffer.from(text);
    const mask = crypto.randomBytes(4);
    return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!))]);
  }

  function nextMessage(socket: net.Socket, pre = Buffer.alloc(0)): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      let buf = pre;
      const onData = (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        if (buf.length < 2) return;
        const len = buf[1]!;
        if (buf.length < 2 + len) return;
        socket.off("data", onData);
        resolve(JSON.parse(buf.subarray(2, 2 + len).toString()));
      };
      if (buf.length) onData(Buffer.alloc(0));
      socket.on("data", onData);
    });
  }

  it("refuses to upgrade without the token", async () => {
    const port = await boot();
    const { head, socket } = await connect(port, "/v1/ws");
    expect(head.startsWith("HTTP/1.1 401")).toBe(true);
    socket.destroy();
  });

  it("sends the state on connect, runs commands and pushes changes", async () => {
    const port = await boot();
    const { head, socket } = await connect(port, `/v1/ws?token=${TOKEN}`);
    expect(head.startsWith("HTTP/1.1 101")).toBe(true);
    expect(head).toContain("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    // The first state message may be glued to the handshake reply.
    const afterHead = Buffer.from(head, "latin1").subarray(head.indexOf("\r\n\r\n") + 4);
    const first = await nextMessage(socket, afterHead);
    expect(first).toEqual({ type: "state", state: { playing: false } });

    const reply = nextMessage(socket);
    socket.write(clientFrame('{"id":7,"command":"next"}'));
    expect(await reply).toEqual({ id: 7, ok: true, result: { done: "next" } });

    const bad = nextMessage(socket);
    socket.write(clientFrame('{"id":8,"command":"bad name"}'));
    expect(await bad).toEqual({ id: 8, ok: false, error: "bad_command_name" });

    state = { playing: true };
    const pushed = nextMessage(socket);
    server!.broadcastState();
    expect(await pushed).toEqual({ type: "state", state: { playing: true } });
    socket.destroy();
  });
});