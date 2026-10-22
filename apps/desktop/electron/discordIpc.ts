import net from "node:net";
import { randomUUID } from "node:crypto";
import { APPLICATION_ID_RE, clampText, isPublicImageUrl, type DiscordStatus, type PresenceActivity } from "./presenceShared";
export { APPLICATION_ID_RE, isPublicImageUrl, type DiscordState, type DiscordStatus, type PresenceActivity } from "./presenceShared";


// Discord Rich Presence over Discord's local IPC. The desktop Discord client
// listens on a named pipe (Windows) or unix socket (macOS, Linux); messages
// are frames of [op: int32 LE][length: int32 LE][JSON payload]. That is the
// whole protocol, so there is no dependency on a Discord library.

export const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 } as const;

/** Discord rejects frames above 64 KiB; anything much bigger is garbage. */
const MAX_PAYLOAD = 1024 * 1024;

export interface Frame {
  op: number;
  data: unknown;
}

export function encodeFrame(op: number, payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const buf = Buffer.alloc(8 + json.length);
  buf.writeInt32LE(op, 0);
  buf.writeInt32LE(json.length, 4);
  json.copy(buf, 8);
  return buf;
}

/** Reassembles frames from a byte stream (chunks can split or join frames). */
export class FrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];
    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const length = this.buffer.readInt32LE(4);
      if (length < 0 || length > MAX_PAYLOAD) throw new Error("Bad frame length from Discord");
      if (this.buffer.length < 8 + length) break;
      const body = this.buffer.subarray(8, 8 + length).toString("utf8");
      this.buffer = this.buffer.subarray(8 + length);
      let data: unknown = null;
      if (body.length > 0) {
        try {
          data = JSON.parse(body);
        } catch {
          throw new Error("Discord sent invalid JSON");
        }
      }
      frames.push({ op, data });
    }
    return frames;
  }
}

/** Where Discord might be listening, in the order to try. */
export function ipcPaths(platform: string, env: Record<string, string | undefined>): string[] {
  const paths: string[] = [];
  if (platform === "win32") {
    for (let i = 0; i < 10; i++) paths.push(`\\\\?\\pipe\\discord-ipc-${i}`);
    return paths;
  }
  const dirs = [env.XDG_RUNTIME_DIR, env.TMPDIR, env.TMP, env.TEMP, "/tmp"].filter(
    (d): d is string => typeof d === "string" && d.length > 0,
  );
  const unique = [...new Set(dirs.map((d) => d.replace(/\/+$/, "")))];
  // Flatpak and Snap builds of Discord keep their socket in a sandbox folder.
  const subdirs = ["", "/app/com.discordapp.Discord", "/snap.discord"];
  for (let i = 0; i < 10; i++) {
    for (const dir of unique) for (const sub of subdirs) paths.push(`${dir}${sub}/discord-ipc-${i}`);
  }
  return paths;
}

/** Seconds to wait before reconnect attempt number `attempt` (0 is the first retry). */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt));
  // Up to 20% jitter so many clients don't retry in lockstep.
  return Math.round(base * (1 + random() * 0.2));
}

/** Check an untrusted activity from the renderer; null if unusable. */
export function parseActivity(input: unknown): PresenceActivity | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const details = clampText(raw.details, 128);
  if (!details) return null;
  const finite = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);
  return {
    details,
    state: clampText(raw.state, 128),
    largeImage: isPublicImageUrl(raw.largeImage) ? raw.largeImage : undefined,
    largeText: clampText(raw.largeText, 128),
    startMs: finite(raw.startMs),
    endMs: finite(raw.endMs),
  };
}

/** The `activity` object of a SET_ACTIVITY command. type 2 shows "Listening to". */
export function toDiscordActivity(a: PresenceActivity): Record<string, unknown> {
  const activity: Record<string, unknown> = { type: 2, details: a.details };
  if (a.state) activity.state = a.state;
  if (a.startMs || a.endMs) {
    activity.timestamps = {
      ...(a.startMs ? { start: a.startMs } : {}),
      ...(a.endMs ? { end: a.endMs } : {}),
    };
  }
  if (a.largeImage) {
    activity.assets = { large_image: a.largeImage, ...(a.largeText ? { large_text: a.largeText } : {}) };
  }
  return activity;
}

/** The small part of a socket we use; real sockets and test fakes both fit. */
export interface IpcSocket {
  write(data: Buffer): unknown;
  destroy(): unknown;
  /** Flush what is queued, then close. */
  end?(): unknown;
  on(event: "data", cb: (chunk: Buffer) => void): unknown;
  on(event: "close" | "error", cb: () => void): unknown;
}

export interface DiscordDeps {
  /** Open one path; reject if nothing is listening there. */
  connect: (path: string) => Promise<IpcSocket>;
  paths: () => string[];
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  pid: number;
  random: () => number;
  now: () => number;
}

export function realDeps(): DiscordDeps {
  return {
    connect: (path) =>
      new Promise<IpcSocket>((resolve, reject) => {
        const socket = net.createConnection(path);
        const onError = (err: Error) => reject(err);
        socket.once("error", onError);
        socket.once("connect", () => {
          socket.off("error", onError);
          resolve(socket as unknown as IpcSocket);
        });
      }),
    paths: () => ipcPaths(process.platform, process.env),
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    pid: process.pid,
    random: Math.random,
    now: () => Date.now(),
  };
}

/** Discord limits how often presence can change; stay well inside it. */
const MIN_UPDATE_GAP_MS = 4_000;
const READY_TIMEOUT_MS = 6_000;

/**
 * Keeps a presence connection alive: connects, shows (or clears) the current
 * activity, and reconnects with backoff when Discord closes or isn't running yet.
 */
export class DiscordPresence {
  private appId: string | null = null;
  private socket: IpcSocket | null = null;
  private decoder = new FrameDecoder();
  private status: DiscordStatus = { state: "off" };
  private attempt = 0;
  private retryTimer: unknown = null;
  private readyTimer: unknown = null;
  private flushTimer: unknown = null;
  private lastSentAt = 0;
  private ready = false;
  private generation = 0;
  private wanted: PresenceActivity | null = null;
  private sentOnce = false;
  private listeners = new Set<(s: DiscordStatus) => void>();

  constructor(private readonly deps: DiscordDeps = realDeps()) {}

  getStatus(): DiscordStatus {
    return this.status;
  }

  onStatus(cb: (s: DiscordStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private setStatus(next: DiscordStatus) {
    if (next.state === this.status.state && next.error === this.status.error && next.user === this.status.user) return;
    this.status = next;
    for (const cb of this.listeners) cb(next);
  }

  /** Start (or restart with a new application id). */
  start(appId: string): void {
    if (!APPLICATION_ID_RE.test(appId)) throw new Error("That is not a Discord application ID (a 17 to 20 digit number)");
    if (this.appId === appId && this.status.state !== "off") return;
    this.stop();
    this.appId = appId;
    this.attempt = 0;
    this.setStatus({ state: "connecting" });
    void this.open();
  }

  /** Show this activity, or clear it with null. Safe to call before the connection is up. */
  setActivity(activity: PresenceActivity | null): void {
    this.wanted = activity;
    this.scheduleFlush();
  }

  stop(): void {
    this.generation++;
    this.appId = null;
    this.clearTimers();
    this.ready = false;
    this.sentOnce = false;
    this.teardownSocket(true);
    this.setStatus({ state: "off" });
  }

  private clearTimers() {
    for (const key of ["retryTimer", "readyTimer", "flushTimer"] as const) {
      if (this[key] != null) this.deps.clearTimeout(this[key]);
      this[key] = null;
    }
  }

  private teardownSocket(sayGoodbye: boolean) {
    const socket = this.socket;
    this.socket = null;
    this.decoder = new FrameDecoder();
    if (!socket) return;
    if (sayGoodbye) {
      try {
        // Clear our activity, then close politely so Discord drops it at once.
        if (this.ready) socket.write(this.activityFrame(null));
        socket.write(encodeFrame(OP.CLOSE, {}));
      } catch {
        // The pipe is already gone.
      }
    }
    try {
      if (sayGoodbye && socket.end) socket.end();
      else socket.destroy();
    } catch {
      // Already closed.
    }
  }

  private async open(): Promise<void> {
    const generation = this.generation;
    const appId = this.appId;
    if (!appId) return;
    let socket: IpcSocket | null = null;
    for (const path of this.deps.paths()) {
      try {
        socket = await this.deps.connect(path);
        break;
      } catch {
        // Try the next pipe; Discord numbers them when several clients run.
      }
    }
    if (generation !== this.generation) {
      socket?.destroy();
      return;
    }
    if (!socket) {
      this.setStatus({ state: "waiting", error: "Discord is not running" });
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    this.decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      if (generation === this.generation && this.socket === socket) this.handleData(socket, chunk);
    });
    const lost = () => {
      if (generation !== this.generation || this.socket !== socket) return;
      this.onLost("Discord closed the connection");
    };
    socket.on("close", lost);
    socket.on("error", lost);
    socket.write(encodeFrame(OP.HANDSHAKE, { v: 1, client_id: appId }));
    this.readyTimer = this.deps.setTimeout(() => {
      if (generation === this.generation && !this.ready) this.onLost("Discord did not answer");
    }, READY_TIMEOUT_MS);
  }

  private handleData(socket: IpcSocket, chunk: Buffer) {
    let frames: Frame[];
    try {
      frames = this.decoder.push(chunk);
    } catch {
      this.onLost("Discord sent something unreadable");
      return;
    }
    for (const frame of frames) {
      if (frame.op === OP.PING) {
        socket.write(encodeFrame(OP.PONG, frame.data));
      } else if (frame.op === OP.CLOSE) {
        const info = (frame.data ?? {}) as { code?: number; message?: string };
        // 4000 is "invalid client id": retrying cannot help.
        if (info.code === 4000) {
          this.fail("Discord does not recognise that application ID");
        } else {
          this.onLost(info.message ? `Discord closed the connection (${info.message})` : "Discord closed the connection");
        }
        return;
      } else if (frame.op === OP.FRAME) {
        const msg = (frame.data ?? {}) as { cmd?: string; evt?: string; data?: { user?: { username?: string } }; code?: number };
        if (msg.evt === "READY") {
          this.ready = true;
          this.attempt = 0;
          if (this.readyTimer != null) this.deps.clearTimeout(this.readyTimer);
          this.readyTimer = null;
          this.setStatus({ state: "connected", user: msg.data?.user?.username });
          this.sentOnce = false;
          this.scheduleFlush();
        } else if (msg.evt === "ERROR") {
          // e.g. a rejected activity; keep the connection.
          this.setStatus({ ...this.status, error: "Discord rejected the update" });
        }
      }
    }
  }

  /** A permanent failure: report it and stop retrying until start() is called again. */
  private fail(error: string) {
    this.generation++;
    this.clearTimers();
    this.ready = false;
    this.teardownSocket(false);
    this.setStatus({ state: "off", error });
    this.appId = null;
  }

  private onLost(reason: string) {
    this.ready = false;
    this.teardownSocket(false);
    if (this.readyTimer != null) this.deps.clearTimeout(this.readyTimer);
    this.readyTimer = null;
    if (!this.appId) return;
    this.setStatus({ state: "waiting", error: reason });
    this.scheduleRetry();
  }

  private scheduleRetry() {
    if (!this.appId || this.retryTimer != null) return;
    const delay = backoffMs(this.attempt++, this.deps.random);
    const generation = this.generation;
    this.retryTimer = this.deps.setTimeout(() => {
      this.retryTimer = null;
      if (generation !== this.generation) return;
      this.setStatus({ state: "connecting" });
      void this.open();
    }, delay);
  }

  private activityFrame(activity: PresenceActivity | null): Buffer {
    return encodeFrame(OP.FRAME, {
      cmd: "SET_ACTIVITY",
      args: { pid: this.deps.pid, activity: activity ? toDiscordActivity(activity) : null },
      nonce: randomUUID(),
    });
  }

  private scheduleFlush() {
    if (!this.ready || !this.socket) return;
    if (this.flushTimer != null) return;
    const wait = this.sentOnce ? Math.max(0, this.lastSentAt + MIN_UPDATE_GAP_MS - this.deps.now()) : 0;
    const run = () => {
      this.flushTimer = null;
      if (!this.ready || !this.socket) return;
      this.socket.write(this.activityFrame(this.wanted));
      this.lastSentAt = this.deps.now();
      this.sentOnce = true;
    };
    if (wait === 0) run();
    else this.flushTimer = this.deps.setTimeout(run, wait);
  }
}