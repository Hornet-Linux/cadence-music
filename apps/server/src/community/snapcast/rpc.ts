import net from "node:net";
import { DeviceError } from "../_devices/rendererRoutes.js";
import { fetchText } from "../_devices/http.js";
import { parseAddress } from "../_devices/net.js";

export interface SnapEndpoint {
  kind: "tcp" | "http";
  host: string;
  port: number;
  /** http only */
  url?: string;
}

/** "192.168.1.5", "host:1705" use the TCP JSON-RPC port; an http(s) URL uses the HTTP /jsonrpc endpoint. */
export function parseSnapAddress(input: string): SnapEndpoint | null {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const url = parseAddress(trimmed, 1780, "/jsonrpc");
    return url ? { kind: "http", host: url.hostname, port: Number(url.port) || 1780, url: url.toString() } : null;
  }
  const url = parseAddress(trimmed, 1705);
  return url ? { kind: "tcp", host: url.hostname, port: Number(url.port) } : null;
}

export type RpcCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

let nextId = 1;

function tcpCall(ep: SnapEndpoint, method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: ep.host, port: ep.port });
    let buf = "";
    const timer = setTimeout(() => fail(new DeviceError("The Snapcast server did not answer.")), timeoutMs);
    const done = () => {
      clearTimeout(timer);
      socket.destroy();
    };
    const fail = (err: Error) => {
      done();
      reject(err);
    };
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\r\n`));
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.length > 4 * 1024 * 1024) return fail(new DeviceError("The Snapcast reply was too large."));
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== id) continue; // a notification
        done();
        if (msg.error) return reject(new DeviceError(`Snapcast refused the request${msg.error.message ? `: ${msg.error.message}` : "."}`));
        return resolve(msg.result);
      }
    });
    socket.on("error", () => fail(new DeviceError("Could not reach the Snapcast server. Check its address and that the JSON-RPC port is open.")));
  });
}

async function httpCall(ep: SnapEndpoint, method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<unknown> {
  const id = nextId++;
  try {
    const res = await fetchText(
      ep.url!,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, jsonrpc: "2.0", method, params }) },
      { timeoutMs, maxBytes: 4 * 1024 * 1024 },
    );
    const msg = JSON.parse(res.text) as { result?: unknown; error?: { message?: string } };
    if (msg.error) throw new DeviceError(`Snapcast refused the request${msg.error.message ? `: ${msg.error.message}` : "."}`);
    return msg.result;
  } catch (err) {
    if (err instanceof DeviceError) throw err;
    throw new DeviceError("Could not reach the Snapcast server. Check its address.");
  }
}

export function makeRpc(ep: SnapEndpoint, timeoutMs = 4000): RpcCall {
  return (method, params) => (ep.kind === "tcp" ? tcpCall(ep, method, params, timeoutMs) : httpCall(ep, method, params, timeoutMs));
}
