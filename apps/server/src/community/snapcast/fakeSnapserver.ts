import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";

export interface FakeSnapserver {
  tcpPort: number;
  httpPort: number;
  calls: { method: string; params: Record<string, unknown> | undefined }[];
  close(): Promise<void>;
}

/** A pretend Snapcast server: the JSON-RPC API over TCP (newline separated) and over HTTP /jsonrpc. */
export async function startFakeSnapserver(opts: { host?: string; tcpPort?: number; httpPort?: number } = {}): Promise<FakeSnapserver> {
  const state = {
    groups: [
      {
        id: "g1",
        name: "Downstairs",
        stream_id: "default",
        muted: false,
        clients: [
          { id: "aa:bb", connected: true, host: { name: "kitchen-pi" }, config: { name: "Kitchen", volume: { muted: false, percent: 60 } } },
          { id: "cc:dd", connected: false, host: { name: "den-pi" }, config: { name: "", volume: { muted: true, percent: 30 } } },
        ],
      },
      { id: "g2", name: "", stream_id: "spotify", muted: true, clients: [] },
    ],
    streams: [
      { id: "default", status: "playing" },
      { id: "spotify", status: "idle" },
    ],
  };
  const calls: FakeSnapserver["calls"] = [];
  const err = (id: number, message: string) => ({ id, jsonrpc: "2.0", error: { code: -32602, message } });

  function handle(req: { id: number; method: string; params?: Record<string, unknown> }) {
    calls.push({ method: req.method, params: req.params });
    const p = req.params ?? {};
    const client = state.groups.flatMap((g) => g.clients).find((c) => c.id === p["id"]);
    const group = state.groups.find((g) => g.id === p["id"]);
    switch (req.method) {
      case "Server.GetStatus":
        return {
          id: req.id,
          jsonrpc: "2.0",
          result: { server: { server: { snapserver: { version: "0.27.0" } }, groups: state.groups, streams: state.streams } },
        };
      case "Client.SetVolume":
        if (!client) return err(req.id, "Client not found");
        client.config.volume = p["volume"] as typeof client.config.volume;
        return { id: req.id, jsonrpc: "2.0", result: { volume: client.config.volume } };
      case "Group.SetMute":
        if (!group) return err(req.id, "Group not found");
        group.muted = p["mute"] === true;
        return { id: req.id, jsonrpc: "2.0", result: { mute: group.muted } };
      case "Group.SetStream":
        if (!group) return err(req.id, "Group not found");
        group.stream_id = String(p["stream_id"]);
        return { id: req.id, jsonrpc: "2.0", result: { stream_id: group.stream_id } };
      default:
        return { id: req.id, jsonrpc: "2.0", error: { code: -32601, message: "Method not found" } };
    }
  }

  const sockets = new Set<net.Socket>();
  const tcp = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        // A notification arrives first, as it can on a real server; clients must skip it.
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "Client.OnVolumeChanged", params: {} })}\r\n`);
        socket.write(`${JSON.stringify(handle(JSON.parse(line)))}\r\n`);
      }
    });
  });
  await new Promise<void>((r) => tcp.listen(opts.tcpPort ?? 0, opts.host ?? "127.0.0.1", r));

  const web = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.url !== "/jsonrpc") {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(handle(JSON.parse(Buffer.concat(chunks).toString("utf8")))));
    });
  });
  await new Promise<void>((r) => web.listen(opts.httpPort ?? 0, opts.host ?? "127.0.0.1", r));

  return {
    tcpPort: (tcp.address() as AddressInfo).port,
    httpPort: (web.address() as AddressInfo).port,
    calls,
    close: async () => {
      for (const s of sockets) s.destroy();
      web.closeAllConnections();
      await Promise.all([new Promise<void>((r) => tcp.close(() => r())), new Promise<void>((r) => web.close(() => r()))]);
    },
  };
}
