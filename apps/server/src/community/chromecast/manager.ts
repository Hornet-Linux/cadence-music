import { DeviceError, type RendererBackend, type RendererDevice, type RendererSession } from "../_devices/rendererRoutes.js";
import { fetchText } from "../_devices/http.js";
import { lanAddresses, parseAddress } from "../_devices/net.js";
import { discoverCasts, type MdnsOptions } from "./mdns.js";
import { ChromecastSession, type CastSessionOptions } from "./session.js";

interface Entry {
  device: RendererDevice;
  host: string;
  port: number;
  lastSeen: number;
}

export interface ManualCast {
  host: string;
  port: number;
  name?: string;
}

export interface ChromecastManagerOptions {
  store: { load(): ManualCast[]; save(list: ManualCast[]): void };
  mdns?: Pick<MdnsOptions, "target" | "interfaces" | "timeoutMs">;
  /** Port of the plain-HTTP info endpoint that gives a device its name. Real devices use 8008. */
  eurekaPort?: number;
  session?: Partial<CastSessionOptions>;
  expireMs?: number;
}

/** Finds Chromecasts (mDNS, plus addresses the admin entered) and hands out sessions to control them. */
export class ChromecastManager implements RendererBackend {
  private readonly entries = new Map<string, Entry>();
  private readonly sessions = new Map<string, ChromecastSession>();
  private manual: ManualCast[];
  private scanning: Promise<void> | null = null;
  private lastScanAt: number | null = null;

  constructor(private readonly opts: ChromecastManagerOptions) {
    this.manual = opts.store.load();
    for (const m of this.manual) this.setEntry(this.manualEntry(m, m.name));
  }

  private manualEntry(m: ManualCast, name?: string, model?: string): Entry {
    return {
      device: {
        id: `manual-${m.host}-${m.port}`,
        name: name ?? m.host,
        kind: "chromecast",
        model,
        address: `${m.host}:${m.port}`,
        manual: true,
      },
      host: m.host,
      port: m.port,
      lastSeen: Date.now(),
    };
  }

  private setEntry(e: Entry) {
    const previous = this.entries.get(e.device.id);
    if (previous && (previous.host !== e.host || previous.port !== e.port)) this.dropSession(e.device.id);
    this.entries.set(e.device.id, e);
  }

  private dropSession(id: string) {
    this.sessions.get(id)?.close();
    this.sessions.delete(id);
  }

  list(): RendererDevice[] {
    const expire = this.opts.expireMs ?? 20 * 60_000;
    const now = Date.now();
    for (const [id, e] of this.entries) {
      if (!e.device.manual && now - e.lastSeen > expire) {
        this.entries.delete(id);
        this.dropSession(id);
      }
    }
    return [...this.entries.values()].map((e) => e.device).sort((a, b) => a.name.localeCompare(b.name));
  }

  info() {
    return {
      discovering: this.scanning !== null,
      lastScanAt: this.lastScanAt,
      hint:
        this.entries.size > 0
          ? "A Chromecast fetches audio from this server, so it must be able to reach the server over your network."
          : "No Chromecasts found. If the server runs in Docker, discovery needs network_mode: host; otherwise add the device address by hand.",
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
    const found = await discoverCasts({ ...this.opts.mdns, interfaces: this.opts.mdns?.interfaces ?? lanAddresses() });
    for (const s of found) {
      this.setEntry({
        device: { id: s.id, name: s.name, kind: "chromecast", model: s.model, address: `${s.host}:${s.port}` },
        host: s.host,
        port: s.port,
        lastSeen: Date.now(),
      });
    }
  }

  async addManual(address: string): Promise<RendererDevice> {
    const url = parseAddress(address, 8009);
    if (!url) throw new DeviceError("That is not a valid address. Use an IP address such as 192.168.1.30.");
    const m: ManualCast = { host: url.hostname, port: Number(url.port) };
    let model: string | undefined;
    try {
      const res = await fetchText(
        `http://${m.host}:${this.opts.eurekaPort ?? 8008}/setup/eureka_info?params=name,device_info`,
        {},
        { timeoutMs: 3000, maxBytes: 64 * 1024 },
      );
      if (res.ok) {
        const info = JSON.parse(res.text) as { name?: string; device_info?: { model_name?: string } };
        m.name = info.name;
        model = info.device_info?.model_name;
      }
    } catch {
      // The name is a nicety; the connection test below decides.
    }
    const probe = new ChromecastSession({ ...this.opts.session, host: m.host, port: m.port, requestTimeoutMs: 4000 });
    try {
      await probe.status();
    } catch {
      throw new DeviceError("No Chromecast answered at that address. Check the address and that the speaker is on the same network as the server.");
    } finally {
      probe.close();
    }
    this.manual = [...this.manual.filter((x) => !(x.host === m.host && x.port === m.port)), m];
    this.opts.store.save(this.manual);
    const entry = this.manualEntry(m, m.name, model);
    this.setEntry(entry);
    return entry.device;
  }

  removeManual(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry?.device.manual) return false;
    this.entries.delete(id);
    this.dropSession(id);
    this.manual = this.manual.filter((x) => !(x.host === entry.host && x.port === entry.port));
    this.opts.store.save(this.manual);
    return true;
  }

  session(id: string): RendererSession | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    let s = this.sessions.get(id);
    if (!s) {
      s = new ChromecastSession({ ...this.opts.session, host: entry.host, port: entry.port });
      this.sessions.set(id, s);
    }
    return s;
  }

  close() {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}
