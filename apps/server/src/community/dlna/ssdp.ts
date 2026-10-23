import dgram from "node:dgram";

export interface SsdpResponse {
  location: string;
  usn: string;
  st: string;
  server?: string;
}

export const SSDP_ADDRESS = "239.255.255.250";
export const SSDP_PORT = 1900;
export const MEDIA_RENDERER_ST = "urn:schemas-upnp-org:device:MediaRenderer:1";

export function parseSsdpResponse(msg: string): SsdpResponse | null {
  const lines = msg.split(/\r?\n/);
  if (!/^HTTP\/1\.[01] 200/i.test(lines[0] ?? "") && !/^NOTIFY /i.test(lines[0] ?? "")) return null;
  const h: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const location = h["location"];
  if (!location || !/^https?:\/\//i.test(location)) return null;
  return { location, usn: h["usn"] ?? location, st: h["st"] ?? h["nt"] ?? "", server: h["server"] };
}

export interface SsdpOptions {
  st?: string;
  timeoutMs?: number;
  /** Where to send the search. Tests point this at a fake renderer; real use is the multicast group. */
  target?: { address: string; port: number };
  /** Local interface addresses to send from. Multi-homed machines need one search per network. */
  interfaces?: string[];
}

/**
 * Send an SSDP M-SEARCH and collect the answers. Answers arrive by unicast to our socket, so a firewall or a
 * container on a bridge network (which does not carry multicast) simply yields nothing.
 */
export function ssdpSearch(opts: SsdpOptions = {}): Promise<SsdpResponse[]> {
  const st = opts.st ?? MEDIA_RENDERER_ST;
  const target = opts.target ?? { address: SSDP_ADDRESS, port: SSDP_PORT };
  const timeoutMs = opts.timeoutMs ?? 2500;
  const interfaces: (string | undefined)[] = opts.interfaces && opts.interfaces.length > 0 ? opts.interfaces : [undefined];
  const message = Buffer.from(
    [
      "M-SEARCH * HTTP/1.1",
      `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
      'MAN: "ssdp:discover"',
      `MX: ${Math.max(1, Math.floor(timeoutMs / 1000) - 1)}`,
      `ST: ${st}`,
      "USER-AGENT: Cadence/1.0 UPnP/1.1",
      "",
      "",
    ].join("\r\n"),
  );

  return new Promise((resolve) => {
    const found = new Map<string, SsdpResponse>();
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve([...found.values()]);
    };
    socket.on("error", finish);
    socket.on("message", (data) => {
      const parsed = parseSsdpResponse(data.toString("utf8"));
      if (parsed && (parsed.st === st || parsed.usn.includes(st))) found.set(parsed.usn, parsed);
    });
    socket.bind(0, () => {
      try {
        socket.setMulticastTTL(2);
      } catch {
        // not fatal
      }
      const sendAll = () => {
        for (const iface of interfaces) {
          try {
            if (iface) socket.setMulticastInterface(iface);
            socket.send(message, target.port, target.address, () => undefined);
          } catch {
            // This network cannot carry the search; try the others.
          }
        }
      };
      sendAll();
      // UDP is lossy: ask again shortly.
      setTimeout(() => !closed && sendAll(), 400).unref();
    });
    setTimeout(finish, timeoutMs).unref();
  });
}
