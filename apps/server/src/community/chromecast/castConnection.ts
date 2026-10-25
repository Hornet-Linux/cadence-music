import tls from "node:tls";
import { DeviceError } from "../_devices/rendererRoutes.js";
import { FrameReader, frame, type CastMessage } from "./castMessage.js";

export const NS_CONNECTION = "urn:x-cast:com.google.cast.tp.connection";
export const NS_HEARTBEAT = "urn:x-cast:com.google.cast.tp.heartbeat";
export const NS_RECEIVER = "urn:x-cast:com.google.cast.receiver";
export const NS_MEDIA = "urn:x-cast:com.google.cast.media";

export type CastPayload = { type: string; requestId?: number; [key: string]: unknown };

export interface CastConnectionOptions {
  host: string;
  port: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** A device never has a certificate a public CA signed; it is only reached on the local network. */
  heartbeatMs?: number;
}

const SENDER = "sender-0";

/**
 * One TLS connection to a Chromecast speaking CASTV2: request/response matching by requestId, the ping
 * heartbeat, and a listener for unsolicited status messages.
 */
export class CastConnection {
  private socket: tls.TLSSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (p: CastPayload) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly listeners = new Set<(m: CastMessage, payload: CastPayload | null) => void>();
  private heartbeat: NodeJS.Timeout | null = null;
  private lastSeen = 0;
  private readonly connected = new Set<string>();
  onClose: (() => void) | null = null;

  constructor(private readonly opts: CastConnectionOptions) {}

  get open(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host: this.opts.host, port: this.opts.port, rejectUnauthorized: false });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new DeviceError("The Chromecast did not answer. Check its address and that it is on the same network."));
      }, this.opts.connectTimeoutMs ?? 5000);
      const reader = new FrameReader();
      socket.once("secureConnect", () => {
        clearTimeout(timer);
        this.socket = socket;
        this.lastSeen = Date.now();
        this.startHeartbeat();
        resolve();
      });
      socket.on("data", (chunk) => {
        this.lastSeen = Date.now();
        try {
          for (const m of reader.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)) this.handle(m);
        } catch {
          socket.destroy();
        }
      });
      socket.on("error", () => {
        clearTimeout(timer);
        if (!this.socket) reject(new DeviceError("Could not connect to the Chromecast."));
      });
      socket.on("close", () => this.teardown());
    });
  }

  private teardown() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.socket = null;
    this.connected.clear();
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new DeviceError("The connection to the Chromecast was lost."));
      this.pending.delete(id);
    }
    this.onClose?.();
  }

  private startHeartbeat() {
    const every = this.opts.heartbeatMs ?? 5000;
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastSeen > every * 4) {
        this.socket?.destroy();
        return;
      }
      this.send(NS_HEARTBEAT, "receiver-0", { type: "PING" });
    }, every);
    this.heartbeat.unref();
  }

  private handle(m: CastMessage) {
    let payload: CastPayload | null = null;
    try {
      payload = m.payload ? (JSON.parse(m.payload) as CastPayload) : null;
    } catch {
      payload = null;
    }
    if (m.namespace === NS_HEARTBEAT && payload?.type === "PING") {
      this.send(NS_HEARTBEAT, m.sourceId, { type: "PONG" });
      return;
    }
    if (payload?.requestId) {
      const p = this.pending.get(payload.requestId);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(payload.requestId);
        p.resolve(payload);
      }
    }
    for (const l of this.listeners) l(m, payload);
  }

  onMessage(listener: (m: CastMessage, payload: CastPayload | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(namespace: string, destinationId: string, payload: CastPayload): void {
    if (!this.socket) throw new DeviceError("The connection to the Chromecast was lost.");
    this.socket.write(frame({ sourceId: SENDER, destinationId, namespace, payload: JSON.stringify(payload) }));
  }

  /** Open a virtual connection to a receiver or app (required before other messages to it). */
  virtualConnect(destinationId: string): void {
    if (this.connected.has(destinationId)) return;
    this.connected.add(destinationId);
    this.send(NS_CONNECTION, destinationId, { type: "CONNECT" });
  }

  request(namespace: string, destinationId: string, payload: CastPayload): Promise<CastPayload> {
    const requestId = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new DeviceError("The Chromecast did not answer."));
      }, this.opts.requestTimeoutMs ?? 8000);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.send(namespace, destinationId, { ...payload, requestId });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(err as Error);
      }
    });
  }

  close(): void {
    this.socket?.destroy();
  }
}
