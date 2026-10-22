import dgram from "node:dgram";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { findNode, parseXml } from "../_devices/xml.js";

export interface FakeRendererCall {
  service: "AVTransport" | "RenderingControl";
  action: string;
  args: Record<string, string>;
}

export interface FakeRenderer {
  ssdpPort: number;
  httpPort: number;
  location: string;
  calls: FakeRendererCall[];
  state: { uri: string; meta: string; transport: string; relTime: string; duration: string; volume: number };
  close(): Promise<void>;
}

/**
 * A pretend UPnP MediaRenderer for tests and local demos: it answers SSDP searches over UDP and serves a
 * device description and the AVTransport / RenderingControl SOAP endpoints over HTTP, on 127.0.0.1.
 */
export async function startFakeRenderer(
  opts: { sonos?: boolean; name?: string; udn?: string; ssdpPort?: number; httpPort?: number } = {},
): Promise<FakeRenderer> {
  const udn = opts.udn ?? (opts.sonos ? "RINCON_000E58AAAAAA01400_MR" : "11111111-2222-3333-4444-555555555555");
  const name = opts.name ?? (opts.sonos ? "Living Room" : "Fake Speaker");
  const calls: FakeRendererCall[] = [];
  const state = { uri: "", meta: "", transport: "STOPPED", relTime: "0:00:00", duration: "0:03:00", volume: 30 };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.method === "GET" && req.url === "/desc.xml") {
        res.setHeader("content-type", "text/xml");
        const inner = `<device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>${name}</friendlyName><manufacturer>${opts.sonos ? "Sonos, Inc." : "Acme"}</manufacturer><modelName>${opts.sonos ? "Sonos One" : "Box 1"}</modelName><UDN>uuid:${udn}</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/ctl/AVTransport</controlURL></service><service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/ctl/RenderingControl</controlURL></service></serviceList></device>`;
        const xml = opts.sonos
          ? `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType><friendlyName>192.168.1.5 - Sonos One</friendlyName><manufacturer>Sonos, Inc.</manufacturer><UDN>uuid:RINCON_000E58AAAAAA01400</UDN><deviceList>${inner}</deviceList></device></root>`
          : `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0">${inner}</root>`;
        res.end(xml);
        return;
      }
      const m = /^\/ctl\/(AVTransport|RenderingControl)$/.exec(req.url ?? "");
      if (req.method === "POST" && m) {
        const action = /#(\w+)"?$/.exec(String(req.headers["soapaction"] ?? ""))?.[1] ?? "";
        const root = parseXml(body);
        const actionNode = findNode(root, action);
        const args: Record<string, string> = {};
        for (const c of actionNode?.children ?? []) args[c.name] = c.text;
        calls.push({ service: m[1] as FakeRendererCall["service"], action, args });
        const reply = (fields: Record<string, string | number> = {}) => {
          const svc = `urn:schemas-upnp-org:service:${m[1]}:1`;
          res.setHeader("content-type", "text/xml");
          res.end(
            `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="${svc}">${Object.entries(fields)
              .map(([k, v]) => `<${k}>${v}</${k}>`)
              .join("")}</u:${action}Response></s:Body></s:Envelope>`,
          );
        };
        switch (action) {
          case "SetAVTransportURI":
            state.uri = args["CurrentURI"] ?? "";
            state.meta = args["CurrentURIMetaData"] ?? "";
            state.transport = "STOPPED";
            state.relTime = "0:00:00";
            return reply();
          case "Play":
            state.transport = "PLAYING";
            return reply();
          case "Pause":
            state.transport = "PAUSED_PLAYBACK";
            return reply();
          case "Stop":
            state.transport = "STOPPED";
            return reply();
          case "Seek":
            state.relTime = args["Target"] ?? "0:00:00";
            return reply();
          case "GetTransportInfo":
            return reply({ CurrentTransportState: state.transport, CurrentTransportStatus: "OK", CurrentSpeed: 1 });
          case "GetPositionInfo":
            return reply({ Track: 1, TrackDuration: state.duration, TrackURI: state.uri, RelTime: state.relTime, AbsTime: state.relTime });
          case "SetVolume":
            state.volume = Number(args["DesiredVolume"] ?? state.volume);
            return reply();
          case "GetVolume":
            return reply({ CurrentVolume: state.volume });
          default:
            res.statusCode = 500;
            res.setHeader("content-type", "text/xml");
            res.end(
              '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>401</errorCode><errorDescription>Invalid Action</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>',
            );
            return;
        }
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.httpPort ?? 0, "127.0.0.1", resolve));
  const httpPort = (server.address() as AddressInfo).port;
  const location = `http://127.0.0.1:${httpPort}/desc.xml`;

  const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
  udp.on("message", (msg, rinfo) => {
    if (!/^M-SEARCH/i.test(msg.toString("utf8"))) return;
    const reply = Buffer.from(
      [
        "HTTP/1.1 200 OK",
        "CACHE-CONTROL: max-age=1800",
        `LOCATION: ${location}`,
        `SERVER: ${opts.sonos ? "Linux UPnP/1.0 Sonos/70.3-88200 (ZPS1)" : "Fake/1.0 UPnP/1.0"}`,
        "ST: urn:schemas-upnp-org:device:MediaRenderer:1",
        `USN: uuid:${udn}::urn:schemas-upnp-org:device:MediaRenderer:1`,
        "",
        "",
      ].join("\r\n"),
    );
    udp.send(reply, rinfo.port, rinfo.address);
  });
  await new Promise<void>((resolve) => udp.bind(opts.ssdpPort ?? 0, "127.0.0.1", resolve));
  const ssdpPort = udp.address().port;

  return {
    ssdpPort,
    httpPort,
    location,
    calls,
    state,
    close: async () => {
      udp.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
