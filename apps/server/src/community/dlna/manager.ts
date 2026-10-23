import { DeviceError, type RendererBackend, type RendererDevice, type RendererSession } from "../_devices/rendererRoutes.js";
import { lanAddresses, parseAddress } from "../_devices/net.js";
import { fetchDescription, UpnpSession, type RendererDescription } from "./upnp.js";
import { ssdpSearch, type SsdpOptions } from "./ssdp.js";

interface Entry {
  desc: RendererDescription;
  lastSeen: number;
  manual: boolean;
}

export interface ManualStore {
  load(): string[];
  save(locations: string[]): void;
}

export interface DlnaManagerOptions {
  store: ManualStore;
  ssdp?: Pick<SsdpOptions, "target" | "interfaces" | "timeoutMs">;
  /** How long a discovered device stays listed without answering. */
  expireMs?: number;
  log?: { warn: (obj: unknown, msg: string) => void };
}

const SONOS_TEXT = "Sonos speakers are UPnP devices, so they show up here too.";

/** Finds UPnP/DLNA renderers (SSDP plus addresses the admin entered) and hands out sessions to control them. */
/** Where renderers usually serve their UPnP device description. */
const DESCRIPTION_PATHS = ["/xml/device_description.xml", "/description.xml", "/desc.xml", "/rootDesc.xml", "/dmr.xml", "/DeviceDescription.xml"];

export class DlnaManager implements RendererBackend {
  private readonly entries = new Map<string, Entry>();
  private manualLocations: string[];
  private scanning: Promise<void> | null = null;
  private lastScanAt: number | null = null;

  constructor(private readonly opts: DlnaManagerOptions) {
    this.manualLocations = opts.store.load();
  }

  list(): RendererDevice[] {
    const expire = this.opts.expireMs ?? 20 * 60_000;
    const now = Date.now();
    const out: RendererDevice[] = [];
    for (const [id, e] of this.entries) {
      if (!e.manual && now - e.lastSeen > expire) {
        this.entries.delete(id);
        continue;
      }
      out.push({
        id,
        name: e.desc.friendlyName,
        kind: e.desc.kind,
        model: e.desc.modelName,
        manufacturer: e.desc.manufacturer,
        address: new URL(e.desc.location).host,
        manual: e.manual,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  info() {
    const hasDevices = this.entries.size > 0;
    return {
      discovering: this.scanning !== null,
      lastScanAt: this.lastScanAt,
      hint: hasDevices
        ? SONOS_TEXT
        : "No devices found. If the server runs in Docker, discovery needs network_mode: host; otherwise add the device address by hand.",
    };
  }

  refresh(): Promise<void> {
    if (!this.scanning) {
      this.scanning = this.scan().finally(() => {
        this.scanning = null;
        this.lastScanAt = Date.now();
      });
    }
    return this.scanning;
  }

  private async scan(): Promise<void> {
    const interfaces = this.opts.ssdp?.interfaces ?? lanAddresses();
    const responses = await ssdpSearch({ ...this.opts.ssdp, interfaces });
    const jobs: Promise<void>[] = responses.map(async (r) => {
      try {
        const desc = await fetchDescription(r.location, r.server);
        if (desc) this.upsert(desc, false);
      } catch (err) {
        this.opts.log?.warn({ err, location: r.location }, "could not read a device description");
      }
    });
    for (const location of this.manualLocations) {
      jobs.push(
        fetchDescription(location)
          .then((desc) => {
            if (desc) this.upsert(desc, true);
          })
          .catch(() => undefined),
      );
    }
    await Promise.all(jobs);
  }

  private upsert(desc: RendererDescription, manual: boolean) {
    const existing = this.entries.get(desc.udn);
    this.entries.set(desc.udn, { desc, lastSeen: Date.now(), manual: manual || (existing?.manual ?? false) });
  }

  async addManual(address: string): Promise<RendererDevice> {
    const candidates = this.candidateLocations(address);
    if (candidates.length === 0) throw new DeviceError("That is not a valid address. Use an IP address such as 192.168.1.20, or a full http:// URL.");
    for (const location of candidates) {
      try {
        const desc = await fetchDescription(location);
        if (!desc) continue;
        this.upsert(desc, true);
        if (!this.manualLocations.includes(location)) {
          this.manualLocations.push(location);
          this.opts.store.save(this.manualLocations);
        }
        return this.list().find((d) => d.id === desc.udn)!;
      } catch {
        // try the next candidate
      }
    }
    throw new DeviceError(
      "No UPnP/DLNA speaker answered at that address. For Sonos use the speaker IP; for others enter the full device description URL (often http://IP:PORT/description.xml).",
    );
  }

  private candidateLocations(address: string): string[] {
    const trimmed = address.trim();
    const hasPathOrPort = /^[a-z]+:\/\//i.test(trimmed) ? /^[a-z]+:\/\/[^/]+(:\d+|\/.+)/i.test(trimmed) : /[:/]/.test(trimmed);
    if (hasPathOrPort) {
      const url = parseAddress(trimmed);
      if (!url) return [];
      if (url.pathname !== "/") return [url.toString()];
      // "IP:PORT" without a path: try the description paths renderers commonly use.
      return DESCRIPTION_PATHS.map((p) => new URL(p, url).toString());
    }
    const host = parseAddress(trimmed);
    if (!host) return [];
    // A bare IP: try Sonos first, then the ports and paths other renderers commonly use.
    return [
      `http://${host.hostname}:1400/xml/device_description.xml`,
      `http://${host.hostname}:49152/description.xml`,
      `http://${host.hostname}:49153/description.xml`,
      `http://${host.hostname}:8080/description.xml`,
    ];
  }

  removeManual(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry?.manual) return false;
    this.entries.delete(id);
    this.manualLocations = this.manualLocations.filter((l) => l !== entry.desc.location);
    this.opts.store.save(this.manualLocations);
    return true;
  }

  session(id: string): RendererSession | null {
    const entry = this.entries.get(id);
    return entry ? new UpnpSession(entry.desc) : null;
  }
}
