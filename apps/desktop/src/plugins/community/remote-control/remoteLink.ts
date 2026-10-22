import { readSse } from "./sse";
import type { RemoteDevice, SseMessage } from "./types";

export type LinkStatus = "off" | "connecting" | "online" | "reconnecting" | "signed-out";

export interface LinkAuth {
  /** Server base URL without a trailing slash. */
  url: string;
  token: string;
}

export interface LinkDeps {
  fetchFn?: typeof fetch;
  getAuth: () => LinkAuth | null;
  getDeviceId: () => string;
  /** Called when the server says another player took this device id; returns the id to use from now on. */
  renewDeviceId: () => string;
  getName: () => string;
  kind: string;
  onStatus: (status: LinkStatus) => void;
  onDevices: (devices: RemoteDevice[]) => void;
  onDeviceState: (device: RemoteDevice) => void;
  onCommand: (command: unknown, from: string | null) => void;
  /** Backoff and watchdog timing; tests shorten it. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** If nothing (not even a keep-alive) arrives for this long the connection is considered dead. */
  idleTimeoutMs?: number;
  random?: () => number;
}

/**
 * Keeps this player registered with the server relay: opens the event stream, hands commands and other devices'
 * state to the callbacks, and reconnects with growing delays when the connection drops or goes quiet.
 */
export class RemoteLink {
  private running = false;
  private abort: AbortController | null = null;
  private wake: (() => void) | null = null;
  private attempt = 0;

  constructor(private readonly deps: LinkDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
    this.wake?.();
    this.deps.onStatus("off");
  }

  /** Reconnect now, e.g. after the browser regains network. */
  nudge(): void {
    this.abort?.abort();
    this.wake?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const auth = this.deps.getAuth();
      if (!auth) {
        this.deps.onStatus("signed-out");
        await this.sleep(2000);
        continue;
      }
      this.deps.onStatus(this.attempt === 0 ? "connecting" : "reconnecting");
      try {
        await this.connectOnce(auth);
      } catch (err) {
        if ((err as { code?: string }).code === "unauthorized") {
          this.deps.onStatus("signed-out");
          await this.sleep(5000);
          continue;
        }
      }
      if (!this.running) break;
      this.deps.onStatus("reconnecting");
      const base = this.deps.baseDelayMs ?? 1000;
      const delay = Math.min(this.deps.maxDelayMs ?? 30_000, base * 2 ** Math.min(this.attempt, 10));
      this.attempt++;
      await this.sleep(delay * (0.75 + (this.deps.random ?? Math.random)() * 0.5));
    }
  }

  private async connectOnce(auth: LinkAuth): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    const params = new URLSearchParams({ deviceId: this.deps.getDeviceId(), name: this.deps.getName(), kind: this.deps.kind });
    const res = await (this.deps.fetchFn ?? fetch)(`${auth.url}/api/remote-control/stream?${params}`, {
      headers: { authorization: `Bearer ${auth.token}`, accept: "text/event-stream" },
      signal: abort.signal,
    });
    if (res.status === 401) throw Object.assign(new Error("unauthorized"), { code: "unauthorized" });
    if (!res.ok || !res.body) throw new Error(`stream failed (${res.status})`);

    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => abort.abort(), this.deps.idleTimeoutMs ?? 45_000);
    };
    arm();
    try {
      await readSse(res.body, (m) => this.handle(m), arm);
    } finally {
      clearTimeout(watchdog);
    }
  }

  private handle(m: SseMessage): void {
    const data = m.data as Record<string, unknown>;
    switch (m.event) {
      case "hello":
        this.attempt = 0;
        this.deps.onStatus("online");
        this.deps.onDevices((data["devices"] as RemoteDevice[]) ?? []);
        break;
      case "devices":
        this.deps.onDevices((data["devices"] as RemoteDevice[]) ?? []);
        break;
      case "state":
        this.deps.onDeviceState(data["device"] as RemoteDevice);
        break;
      case "command":
        this.deps.onCommand(data["command"], (data["from"] as string | null) ?? null);
        break;
      case "replaced":
        // Another player (a duplicated tab) is using this id: take a fresh one and reconnect.
        this.deps.renewDeviceId();
        break;
    }
  }
}
