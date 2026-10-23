// @vitest-environment node
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DiscordPresence,
  FrameDecoder,
  OP,
  backoffMs,
  encodeFrame,
  ipcPaths,
  isPublicImageUrl,
  parseActivity,
  realDeps,
  toDiscordActivity,
  type DiscordDeps,
  type IpcSocket,
} from "./discordIpc";

describe("frame encoding", () => {
  it("writes op and length as little-endian int32 then the JSON", () => {
    const frame = encodeFrame(OP.HANDSHAKE, { v: 1, client_id: "123" });
    const json = '{"v":1,"client_id":"123"}';
    expect(frame.readInt32LE(0)).toBe(0);
    expect(frame.readInt32LE(4)).toBe(json.length);
    expect(frame.subarray(8).toString("utf8")).toBe(json);
  });

  it("counts bytes, not characters, for the length", () => {
    const frame = encodeFrame(OP.FRAME, { t: "\u00e9\u2014" });
    expect(frame.readInt32LE(4)).toBe(frame.length - 8);
  });

  it("decodes frames split across chunks and several frames in one chunk", () => {
    const a = encodeFrame(OP.FRAME, { evt: "READY" });
    const b = encodeFrame(OP.PING, { n: 1 });
    const all = Buffer.concat([a, b]);
    const decoder = new FrameDecoder();
    expect(decoder.push(all.subarray(0, 5))).toEqual([]);
    expect(decoder.push(all.subarray(5, 12))).toEqual([]);
    const frames = decoder.push(all.subarray(12));
    expect(frames).toEqual([
      { op: OP.FRAME, data: { evt: "READY" } },
      { op: OP.PING, data: { n: 1 } },
    ]);
  });

  it("rejects absurd lengths and invalid JSON", () => {
    const huge = Buffer.alloc(8);
    huge.writeInt32LE(1, 0);
    huge.writeInt32LE(50_000_000, 4);
    expect(() => new FrameDecoder().push(huge)).toThrow(/length/);
    const bad = Buffer.concat([Buffer.alloc(8), Buffer.from("{nope")]);
    bad.writeInt32LE(1, 0);
    bad.writeInt32LE(5, 4);
    expect(() => new FrameDecoder().push(bad)).toThrow(/JSON/);
  });
});

describe("pipe paths", () => {
  it("uses numbered named pipes on Windows", () => {
    const paths = ipcPaths("win32", {});
    expect(paths[0]).toBe("\\\\?\\pipe\\discord-ipc-0");
    expect(paths).toHaveLength(10);
  });

  it("looks in the runtime dir and the Flatpak and Snap folders elsewhere", () => {
    const paths = ipcPaths("linux", { XDG_RUNTIME_DIR: "/run/user/1000/" });
    expect(paths[0]).toBe("/run/user/1000/discord-ipc-0");
    expect(paths).toContain("/run/user/1000/app/com.discordapp.Discord/discord-ipc-0");
    expect(paths).toContain("/run/user/1000/snap.discord/discord-ipc-0");
    expect(paths).toContain("/tmp/discord-ipc-3");
  });
});

describe("backoff", () => {
  it("doubles from two seconds up to a minute", () => {
    const none = () => 0;
    expect([0, 1, 2, 3, 4, 5, 6, 20].map((n) => backoffMs(n, none))).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  });
  it("adds at most 20% jitter", () => {
    expect(backoffMs(0, () => 1)).toBe(2400);
  });
});

describe("activity validation", () => {
  it("only trusts public https images", () => {
    expect(isPublicImageUrl("https://i.scdn.co/image/abc")).toBe(true);
    for (const bad of [
      "http://example.com/a.png",
      "https://localhost/a.png",
      "https://127.0.0.1/a.png",
      "https://192.168.1.4/a.png",
      "https://10.0.0.2/a.png",
      "https://172.20.0.1/a.png",
      "https://169.254.1.1/a.png",
      "https://nas.local/a.png",
      "https://user:pw@example.com/a.png",
      "https://[::1]/a.png",
      "https://intranet/a.png",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      `https://example.com/${"a".repeat(300)}`,
    ]) {
      expect(isPublicImageUrl(bad), bad).toBe(false);
    }
  });

  it("clamps text to Discord's 2 to 128 character window", () => {
    const a = parseActivity({ details: "x", state: "y".repeat(200) });
    expect(a?.details).toBe("x\u00a0");
    expect(a?.state?.length).toBe(128);
    expect(parseActivity({ details: "" })).toBeNull();
    expect(parseActivity(null)).toBeNull();
    expect(parseActivity({ details: 5 })).toBeNull();
  });

  it("drops private images and bad timestamps, and maps to Discord's shape", () => {
    const a = parseActivity({
      details: "Song",
      state: "by Artist",
      largeImage: "https://192.168.0.5/a.png",
      startMs: -5,
      endMs: Number.NaN,
    });
    expect(a).toEqual({ details: "Song", state: "by Artist", largeImage: undefined, largeText: undefined, startMs: undefined, endMs: undefined });
    const full = toDiscordActivity({
      details: "Song",
      state: "by Artist",
      largeImage: "https://i.scdn.co/a",
      largeText: "Album",
      startMs: 1000,
      endMs: 5000,
    });
    expect(full).toEqual({
      type: 2,
      details: "Song",
      state: "by Artist",
      timestamps: { start: 1000, end: 5000 },
      assets: { large_image: "https://i.scdn.co/a", large_text: "Album" },
    });
    expect(toDiscordActivity({ details: "Only" })).toEqual({ type: 2, details: "Only" });
  });
});

// ---- A fake Discord to drive the connection logic --------------------------------

class FakeSocket implements IpcSocket {
  written: Buffer[] = [];
  closed = false;
  private dataCb: ((c: Buffer) => void) | null = null;
  private closeCbs: (() => void)[] = [];
  write(data: Buffer) {
    this.written.push(data);
  }
  destroy() {
    this.closed = true;
  }
  end() {
    this.closed = true;
  }
  on(event: string, cb: (...a: never[]) => void) {
    if (event === "data") this.dataCb = cb as (c: Buffer) => void;
    else this.closeCbs.push(cb as () => void);
  }
  receive(op: number, payload: unknown) {
    this.dataCb?.(encodeFrame(op, payload));
  }
  drop() {
    for (const cb of this.closeCbs) cb();
  }
  frames() {
    const decoder = new FrameDecoder();
    return this.written.flatMap((w) => decoder.push(w));
  }
}

function harness(opts: { available?: () => boolean } = {}) {
  let clock = 1_000_000;
  const timers: { at: number; cb: () => void; id: number; live: boolean }[] = [];
  let nextId = 1;
  const sockets: FakeSocket[] = [];
  const attempted: string[] = [];
  const deps: DiscordDeps = {
    connect: async (path) => {
      attempted.push(path);
      if (opts.available && !opts.available()) throw new Error("ENOENT");
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    paths: () => ["pipe-0", "pipe-1"],
    setTimeout: (cb, ms) => {
      const t = { at: clock + ms, cb, id: nextId++, live: true };
      timers.push(t);
      return t.id;
    },
    clearTimeout: (h) => {
      const t = timers.find((x) => x.id === h);
      if (t) t.live = false;
    },
    pid: 4242,
    random: () => 0,
    now: () => clock,
  };
  const advance = async (ms: number) => {
    clock += ms;
    for (const t of timers.filter((x) => x.live && x.at <= clock).sort((a, b) => a.at - b.at)) {
      t.live = false;
      t.cb();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  return { deps, sockets, attempted, advance, flush };
}

const ID = "123456789012345678";
const ready = { cmd: "DISPATCH", evt: "READY", data: { user: { username: "listener" } } };

describe("DiscordPresence", () => {
  it("rejects an application id that is not a snowflake", () => {
    expect(() => new DiscordPresence(harness().deps).start("abc")).toThrow(/application ID/);
  });

  it("handshakes, goes connected on READY, and sends the wanted activity", async () => {
    const h = harness();
    const p = new DiscordPresence(h.deps);
    const seen: string[] = [];
    p.onStatus((s) => seen.push(s.state));
    p.setActivity({ details: "Song", state: "Artist" });
    p.start(ID);
    await h.flush();
    const socket = h.sockets[0]!;
    expect(socket.frames()[0]).toEqual({ op: OP.HANDSHAKE, data: { v: 1, client_id: ID } });
    socket.receive(OP.FRAME, ready);
    expect(p.getStatus()).toEqual({ state: "connected", user: "listener" });
    const sent = socket.frames().find((f) => (f.data as { cmd?: string }).cmd === "SET_ACTIVITY");
    expect((sent!.data as { args: { pid: number; activity: { details: string } } }).args.pid).toBe(4242);
    expect((sent!.data as { args: { activity: { details: string } } }).args.activity.details).toBe("Song");
    expect(seen).toEqual(["connecting", "connected"]);
  });

  it("answers PING with PONG", async () => {
    const h = harness();
    const p = new DiscordPresence(h.deps);
    p.start(ID);
    await h.flush();
    h.sockets[0]!.receive(OP.PING, { n: 7 });
    expect(h.sockets[0]!.frames().at(-1)).toEqual({ op: OP.PONG, data: { n: 7 } });
  });

  it("tries the next pipe when the first is not there", async () => {
    let tries = 0;
    const h = harness();
    const original = h.deps.connect;
    h.deps.connect = async (path) => {
      if (tries++ === 0) throw new Error("ENOENT");
      return original(path);
    };
    new DiscordPresence(h.deps).start(ID);
    await h.flush();
    expect(h.sockets).toHaveLength(1);
  });

  it("waits and retries with backoff when Discord is not running, then connects", async () => {
    let up = false;
    const h = harness({ available: () => up });
    const p = new DiscordPresence(h.deps);
    p.start(ID);
    await h.flush();
    expect(p.getStatus()).toEqual({ state: "waiting", error: "Discord is not running" });
    const tries = h.attempted.length;
    await h.advance(1000);
    expect(h.attempted.length).toBe(tries); // not yet: first retry waits 2s
    up = true;
    await h.advance(1500);
    await h.flush();
    expect(h.attempted.length).toBeGreaterThan(tries);
    h.sockets[0]!.receive(OP.FRAME, ready);
    expect(p.getStatus().state).toBe("connected");
  });

  it("reconnects after Discord closes and re-sends the activity", async () => {
    const h = harness();
    const p = new DiscordPresence(h.deps);
    p.start(ID);
    await h.flush();
    h.sockets[0]!.receive(OP.FRAME, ready);
    p.setActivity({ details: "Song" });
    h.sockets[0]!.drop();
    expect(p.getStatus().state).toBe("waiting");
    await h.advance(2500);
    await h.flush();
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]!.receive(OP.FRAME, ready);
    await h.advance(5000);
    const sent = h.sockets[1]!.frames().filter((f) => (f.data as { cmd?: string }).cmd === "SET_ACTIVITY");
    expect(sent).toHaveLength(1);
  });

  it("does not retry after an invalid-id close", async () => {
    const h = harness();
    const p = new DiscordPresence(h.deps);
    p.start(ID);
    await h.flush();
    h.sockets[0]!.receive(OP.CLOSE, { code: 4000, message: "Invalid Client ID" });
    expect(p.getStatus()).toEqual({ state: "off", error: "Discord does not recognise that application ID" });
    await h.advance(120_000);
    await h.flush();
    expect(h.sockets).toHaveLength(1);
  });

  it("rate-limits updates but always delivers the latest one", async () => {
    const h = harness();
    const p = new DiscordPresence(h.deps);
    p.start(ID);
    await h.flush();
    const socket = h.sockets[0]!;
    socket.receive(OP.FRAME, ready);
    const updates = () => socket.frames().filter((f) => (f.data as { cmd?: string }).cmd === "SET_ACTIVITY");
    p.setActivity({ details: "One" });
    p.setActivity({ details: "Two" });
    p.setActivity({ details: "Three" });
    expect(updates()).toHaveLength(1); // only the first goes out at once
    await h.advance(4100);
    const all = updates();
    expect(all).toHaveLength(2);
    expect((all[1]!.data as { args: { activity: { details: string } } }).args.activity.details).toBe("Three");
  });

  it("clears the activity and closes politely on stop", async () => {
    const h = harness();
    const p = new DiscordPresence(h.deps);
    p.start(ID);
    await h.flush();
    h.sockets[0]!.receive(OP.FRAME, ready);
    p.stop();
    const frames = h.sockets[0]!.frames();
    const last = frames.at(-2)!.data as { args: { activity: unknown } };
    expect(last.args.activity).toBeNull();
    expect(frames.at(-1)!.op).toBe(OP.CLOSE);
    expect(h.sockets[0]!.closed).toBe(true);
    expect(p.getStatus().state).toBe("off");
  });

  it("gives up if Discord never answers the handshake", async () => {
    const h = harness();
    const p = new DiscordPresence(h.deps);
    p.start(ID);
    await h.flush();
    await h.advance(7000);
    expect(p.getStatus().state).toBe("waiting");
  });
});
describe("over a real pipe", () => {
  it("talks to a stand-in Discord on a named pipe or unix socket", async () => {
    const address =
      process.platform === "win32"
        ? `\\\\.\\pipe\\cadence-test-${process.pid}-${Date.now()}`
        : path.join(os.tmpdir(), `cadence-test-${process.pid}-${Date.now()}.sock`);
    const received: { op: number; data: unknown }[] = [];
    const server = net.createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on("data", (chunk) => {
        for (const frame of decoder.push(chunk)) {
          received.push(frame);
          if (frame.op === OP.HANDSHAKE) socket.write(encodeFrame(OP.FRAME, ready));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(address, resolve));
    try {
      const p = new DiscordPresence({ ...realDeps(), paths: () => [address] });
      const connected = new Promise<void>((resolve) => p.onStatus((s) => s.state === "connected" && resolve()));
      p.setActivity({ details: "Real pipe", state: "works" });
      p.start(ID);
      await connected;
      await new Promise((r) => setTimeout(r, 100));
      expect(received[0]).toEqual({ op: OP.HANDSHAKE, data: { v: 1, client_id: ID } });
      const set = received.find((f) => (f.data as { cmd?: string }).cmd === "SET_ACTIVITY");
      expect((set!.data as { args: { activity: { details: string } } }).args.activity.details).toBe("Real pipe");
      p.stop();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});