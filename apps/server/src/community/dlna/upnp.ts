import { DeviceError, type LoadRequest, type RendererSession, type RendererStatus } from "../_devices/rendererRoutes.js";
import { fetchText } from "../_devices/http.js";
import { childText, escapeXml, findAllNodes, findNode, parseXml, type XmlNode } from "../_devices/xml.js";

const AVT = "urn:schemas-upnp-org:service:AVTransport:";
const RC = "urn:schemas-upnp-org:service:RenderingControl:";

export interface UpnpService {
  serviceType: string;
  controlUrl: string;
}

export interface RendererDescription {
  /** The renderer's UDN without the "uuid:" prefix. */
  udn: string;
  friendlyName: string;
  manufacturer?: string;
  modelName?: string;
  location: string;
  avTransport: UpnpService;
  renderingControl?: UpnpService;
  kind: "sonos" | "upnp";
}

function deviceNodes(root: XmlNode): XmlNode[] {
  return findAllNodes(root, "device");
}

function serviceOf(device: XmlNode, prefix: string, location: URL, urlBase?: string): UpnpService | undefined {
  for (const svc of findAllNodes(device, "service")) {
    const type = childText(svc, "serviceType");
    const control = childText(svc, "controlURL");
    if (!type || !control || !type.startsWith(prefix)) continue;
    let resolved: URL;
    try {
      resolved = new URL(control, urlBase ?? location);
    } catch {
      continue;
    }
    // A description may not point control at another machine: that would let a device (or a forged
    // address) make the server send requests elsewhere.
    if (resolved.hostname !== location.hostname || !/^https?:$/.test(resolved.protocol)) continue;
    return { serviceType: type, controlUrl: resolved.toString() };
  }
  return undefined;
}

/** Read a UPnP device description. Returns null if it has no AVTransport service (not a media renderer). */
export function parseDescription(xml: string, location: string, serverHeader?: string): RendererDescription | null {
  const root = parseXml(xml);
  const loc = new URL(location);
  const urlBase = findNode(root, "URLBase")?.text.trim() || undefined;
  const devices = deviceNodes(root);
  // The device that owns the AVTransport service is the renderer (Sonos nests it inside a ZonePlayer).
  const renderer = devices.find((d) => d.children.some((c) => c.name === "serviceList") && serviceOf(d, AVT, loc, urlBase));
  if (!renderer) return null;
  const avTransport = serviceOf(renderer, AVT, loc, urlBase)!;
  const rootDevice = devices[0] ?? renderer;
  const udn = (childText(renderer, "UDN") ?? childText(rootDevice, "UDN") ?? loc.host).replace(/^uuid:/i, "");
  const manufacturer = childText(renderer, "manufacturer") ?? childText(rootDevice, "manufacturer");
  const modelName = childText(renderer, "modelName") ?? childText(rootDevice, "modelName");
  const friendlyName = childText(renderer, "friendlyName") ?? childText(rootDevice, "friendlyName") ?? loc.host;
  const looksSonos = /sonos/i.test(`${manufacturer ?? ""} ${modelName ?? ""} ${serverHeader ?? ""} ${udn}`) || /^RINCON_/i.test(udn);
  return {
    udn,
    friendlyName,
    manufacturer,
    modelName,
    location,
    avTransport,
    renderingControl: serviceOf(renderer, RC, loc, urlBase),
    kind: looksSonos ? "sonos" : "upnp",
  };
}

export async function fetchDescription(location: string, serverHeader?: string): Promise<RendererDescription | null> {
  const res = await fetchText(location, { headers: { accept: "text/xml, application/xml" } }, { timeoutMs: 4000, maxBytes: 512 * 1024 });
  if (!res.ok) return null;
  return parseDescription(res.text, location, serverHeader);
}

/** A SOAP call to a UPnP service; returns the reply's output arguments. */
export async function soapCall(
  service: UpnpService,
  action: string,
  args: Record<string, string | number> = {},
  timeoutMs = 5000,
): Promise<Record<string, string>> {
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${service.serviceType}">` +
    Object.entries(args)
      .map(([k, v]) => `<${k}>${escapeXml(String(v))}</${k}>`)
      .join("") +
    `</u:${action}></s:Body></s:Envelope>`;
  const res = await fetchText(
    service.controlUrl,
    {
      method: "POST",
      headers: { "content-type": 'text/xml; charset="utf-8"', soapaction: `"${service.serviceType}#${action}"` },
      body,
    },
    { timeoutMs, maxBytes: 512 * 1024 },
  );
  const root = parseXml(res.text);
  if (!res.ok) {
    const fault = findNode(root, "UPnPError");
    const desc = fault ? childText(fault, "errorDescription") : undefined;
    const code = fault ? childText(fault, "errorCode") : undefined;
    throw new DeviceError(`The device refused ${action}${desc ? `: ${desc}` : code ? ` (error ${code})` : ""}.`);
  }
  const reply = findNode(root, `${action}Response`);
  const out: Record<string, string> = {};
  for (const child of reply?.children ?? []) out[child.name] = child.text;
  return out;
}

export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** "0:01:23" or "0:01:23.500" to seconds; "NOT_IMPLEMENTED" and friends give undefined. */
export function parseTime(text: string | undefined): number | undefined {
  const m = /^(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/.exec((text ?? "").trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : undefined;
}

export function didlLite(req: LoadRequest): string {
  const res =
    `<res protocolInfo="http-get:*:${escapeXml(req.mime ?? "audio/mpeg")}:*"` +
    (req.durationSec ? ` duration="${formatTime(req.durationSec)}"` : "") +
    `>${escapeXml(req.url)}</res>`;
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="0" parentID="-1" restricted="1">' +
    `<dc:title>${escapeXml(req.title)}</dc:title>` +
    (req.artist ? `<upnp:artist>${escapeXml(req.artist)}</upnp:artist><dc:creator>${escapeXml(req.artist)}</dc:creator>` : "") +
    (req.album ? `<upnp:album>${escapeXml(req.album)}</upnp:album>` : "") +
    (req.artwork ? `<upnp:albumArtURI>${escapeXml(req.artwork)}</upnp:albumArtURI>` : "") +
    "<upnp:class>object.item.audioItem.musicTrack</upnp:class>" +
    res +
    "</item></DIDL-Lite>"
  );
}

const STATES: Record<string, RendererStatus["state"]> = {
  PLAYING: "playing",
  PAUSED_PLAYBACK: "paused",
  PAUSED_RECORDING: "paused",
  STOPPED: "stopped",
  NO_MEDIA_PRESENT: "stopped",
  TRANSITIONING: "buffering",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Control of one UPnP/DLNA MediaRenderer (including Sonos) through AVTransport and RenderingControl. */
export class UpnpSession implements RendererSession {
  constructor(
    private readonly desc: RendererDescription,
    private readonly opts: { pollMs?: number } = {},
  ) {}

  private avt(action: string, args: Record<string, string | number> = {}) {
    return soapCall(this.desc.avTransport, action, { InstanceID: 0, ...args });
  }

  private async state(): Promise<RendererStatus["state"]> {
    const info = await this.avt("GetTransportInfo");
    return STATES[info["CurrentTransportState"] ?? ""] ?? "unknown";
  }

  async load(req: LoadRequest): Promise<void> {
    await this.avt("SetAVTransportURI", { CurrentURI: req.url, CurrentURIMetaData: didlLite(req) });
    if (!req.autoplay && req.startSec < 1) return;
    await this.avt("Play", { Speed: "1" });
    if (req.startSec >= 1) {
      // Renderers only accept a seek once they are playing.
      for (let i = 0; i < 8; i++) {
        if ((await this.state().catch(() => "unknown")) === "playing") break;
        await sleep(this.opts.pollMs ?? 400);
      }
      await this.seek(req.startSec).catch(() => undefined);
    }
    if (!req.autoplay) await this.pause();
  }

  async pause(): Promise<void> {
    await this.avt("Pause");
  }

  async resume(): Promise<void> {
    await this.avt("Play", { Speed: "1" });
  }

  async stop(): Promise<void> {
    await this.avt("Stop");
  }

  async seek(positionSec: number): Promise<void> {
    await this.avt("Seek", { Unit: "REL_TIME", Target: formatTime(positionSec) });
  }

  async setVolume(level: number): Promise<void> {
    const rc = this.desc.renderingControl;
    if (!rc) throw new DeviceError("This device does not have a volume control.");
    await soapCall(rc, "SetVolume", { InstanceID: 0, Channel: "Master", DesiredVolume: Math.round(level * 100) });
  }

  async status(): Promise<RendererStatus> {
    const rc = this.desc.renderingControl;
    const [state, pos, vol] = await Promise.all([
      this.state(),
      this.avt("GetPositionInfo").catch(() => ({}) as Record<string, string>),
      rc ? soapCall(rc, "GetVolume", { InstanceID: 0, Channel: "Master" }).catch(() => null) : Promise.resolve(null),
    ]);
    const volume = vol && vol["CurrentVolume"] !== undefined ? Number(vol["CurrentVolume"]) / 100 : undefined;
    return {
      state,
      positionSec: parseTime(pos["RelTime"]),
      durationSec: parseTime(pos["TrackDuration"]),
      volume: volume !== undefined && Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : undefined,
    };
  }
}
