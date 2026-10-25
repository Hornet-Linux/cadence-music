import dgram from "node:dgram";
import http from "node:http";
import tls from "node:tls";
import type { AddressInfo } from "node:net";
import { FrameReader, frame, type CastMessage } from "./castMessage.js";
import { NS_CONNECTION, NS_HEARTBEAT, NS_MEDIA, NS_RECEIVER } from "./castConnection.js";
import { selfSignedCertificate } from "./testCert.js";

export interface FakeCast {
  castPort: number;
  mdnsPort: number;
  eurekaPort: number;
  /** Every JSON message a sender sent, in order. */
  received: { namespace: string; destinationId: string; payload: Record<string, unknown> }[];
  state: { appRunning: boolean; volume: number; media: Record<string, unknown> | null; playerState: string; currentTime: number };
  close(): Promise<void>;
}

function name(n: string): Buffer {
  const parts = n.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
  return Buffer.concat([...parts, Buffer.from([0])]);
}

function record(owner: string, type: number, data: Buffer): Buffer {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(1, 2);
  head.writeUInt32BE(120, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([name(owner), head, data]);
}

/** An mDNS answer announcing one Chromecast on 127.0.0.1. */
export function castAnnouncement(opts: { id: string; fn: string; md: string; port: number; address?: string }): Buffer {
  const instance = `${opts.fn.replace(/ /g, "-")}._googlecast._tcp.local`;
  const target = `${opts.id}.local`;
  const srv = Buffer.alloc(6);
  srv.writeUInt16BE(opts.port, 4);
  const txt = [`id=${opts.id}`, `fn=${opts.fn}`, `md=${opts.md}`].map((s) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s)]));
  const records = [
    record("_googlecast._tcp.local", 12, name(instance)),
    record(instance, 33, Buffer.concat([srv, name(target)])),
    record(instance, 16, Buffer.concat(txt)),
    record(target, 1, Buffer.from((opts.address ?? "127.0.0.1").split(".").map(Number))),
  ];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 6);
  header.writeUInt16BE(3, 10);
  return Buffer.concat([header, ...records]);
}

/** A pretend Chromecast: TLS CASTV2 on a local port, an mDNS responder and the plain-HTTP info endpoint. */
export async function startFakeCast(opts: { id?: string; fn?: string; md?: string; host?: string; castPort?: number; eurekaPort?: number } = {}): Promise<FakeCast> {
  const id = opts.id ?? "0123456789abcdef0123456789abcdef";
  const fn = opts.fn ?? "Kitchen speaker";
  const md = opts.md ?? "Chromecast Audio";
  const { key, cert } = selfSignedCertificate();
  const received: FakeCast["received"] = [];
  const state: FakeCast["state"] = { appRunning: false, volume: 0.4, media: null, playerState: "IDLE", currentTime: 0 };
  const sockets = new Set<tls.TLSSocket>();

  const server = tls.createServer({ key, cert }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    const reader = new FrameReader();
    const send = (m: CastMessage, payload: Record<string, unknown>) =>
      socket.write(frame({ sourceId: m.destinationId, destinationId: m.sourceId, namespace: m.namespace, payload: JSON.stringify(payload) }));
    const receiverStatus = () => ({
      type: "RECEIVER_STATUS",
      status: {
        applications: state.appRunning ? [{ appId: "CC1AD845", transportId: "web-5", sessionId: "sess-1", displayName: "Default Media Receiver" }] : [],
        volume: { level: state.volume, muted: false },
      },
    });
    const mediaStatus = () => ({
      type: "MEDIA_STATUS",
      status: state.media
        ? [{ mediaSessionId: 1, playerState: state.playerState, currentTime: state.currentTime, media: { duration: 180 } }]
        : [],
    });
    socket.on("data", (chunk) => {
      for (const m of reader.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)) {
        const payload = JSON.parse(m.payload ?? "{}") as Record<string, unknown>;
        if (m.namespace !== NS_HEARTBEAT) received.push({ namespace: m.namespace, destinationId: m.destinationId, payload });
        const requestId = payload["requestId"];
        if (m.namespace === NS_HEARTBEAT && payload["type"] === "PING") send(m, { type: "PONG" });
        else if (m.namespace === NS_CONNECTION) continue;
        else if (m.namespace === NS_RECEIVER) {
          if (payload["type"] === "LAUNCH") state.appRunning = true;
          if (payload["type"] === "SET_VOLUME") state.volume = (payload["volume"] as { level: number }).level;
          send(m, { ...receiverStatus(), requestId });
        } else if (m.namespace === NS_MEDIA) {
          switch (payload["type"]) {
            case "LOAD": {
              const media = payload["media"] as { contentId: string };
              if (media.contentId.includes("fail")) {
                send(m, { type: "LOAD_FAILED", requestId });
                break;
              }
              state.media = payload;
              state.currentTime = Number(payload["currentTime"] ?? 0);
              state.playerState = payload["autoplay"] === false ? "PAUSED" : "PLAYING";
              break;
            }
            case "PAUSE":
              state.playerState = "PAUSED";
              break;
            case "PLAY":
              state.playerState = "PLAYING";
              break;
            case "STOP":
              state.playerState = "IDLE";
              state.media = null;
              break;
            case "SEEK":
              state.currentTime = Number(payload["currentTime"]);
              break;
          }
          if (payload["type"] !== "LOAD" || state.media) send(m, { ...mediaStatus(), requestId });
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(opts.castPort ?? 0, opts.host ?? "127.0.0.1", r));
  const castPort = (server.address() as AddressInfo).port;

  const udp = dgram.createSocket("udp4");
  udp.on("message", (_msg, rinfo) => udp.send(castAnnouncement({ id, fn, md, port: castPort }), rinfo.port, rinfo.address));
  await new Promise<void>((r) => udp.bind(0, opts.host ?? "127.0.0.1", r));

  const eureka = http.createServer((req, res) => {
    if (req.url?.startsWith("/setup/eureka_info")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ name: fn, device_info: { model_name: md } }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => eureka.listen(opts.eurekaPort ?? 0, opts.host ?? "127.0.0.1", r));

  return {
    castPort,
    mdnsPort: udp.address().port,
    eurekaPort: (eureka.address() as AddressInfo).port,
    received,
    state,
    close: async () => {
      udp.close();
      for (const s of sockets) s.destroy();
      eureka.closeAllConnections();
      await Promise.all([new Promise<void>((r) => server.close(() => r())), new Promise<void>((r) => eureka.close(() => r()))]);
    },
  };
}
