import { DeviceError, type LoadRequest, type RendererSession, type RendererStatus } from "../_devices/rendererRoutes.js";
import { CastConnection, NS_MEDIA, NS_RECEIVER, type CastPayload } from "./castConnection.js";

/** The Default Media Receiver from Google: plays a URL with no app of our own to publish. */
export const DEFAULT_MEDIA_RECEIVER = "CC1AD845";

interface MediaStatus {
  mediaSessionId: number;
  playerState?: string;
  idleReason?: string;
  currentTime?: number;
  media?: { duration?: number };
}

interface ReceiverStatus {
  applications?: { appId: string; transportId: string; sessionId: string }[];
  volume?: { level?: number; muted?: boolean };
}

const STATES: Record<string, RendererStatus["state"]> = {
  PLAYING: "playing",
  PAUSED: "paused",
  BUFFERING: "buffering",
  IDLE: "stopped",
};

export interface CastSessionOptions {
  host: string;
  port: number;
  idleCloseMs?: number;
  requestTimeoutMs?: number;
  heartbeatMs?: number;
}

/** Controls one Chromecast: connects on demand, launches the default media receiver, then drives it. */
export class ChromecastSession implements RendererSession {
  private conn: CastConnection | null = null;
  private transportId: string | null = null;
  private mediaSessionId: number | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: CastSessionOptions) {}

  /** Run operations one at a time so a quick pause-then-seek cannot interleave on the wire. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async connection(): Promise<CastConnection> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.disconnect(), this.opts.idleCloseMs ?? 5 * 60_000);
    this.idleTimer.unref();
    if (this.conn?.open) return this.conn;
    const conn = new CastConnection(this.opts);
    await conn.connect();
    conn.onClose = () => {
      if (this.conn === conn) this.disconnect();
    };
    conn.onMessage((_m, payload) => {
      if (payload?.type === "MEDIA_STATUS") this.noteMedia(payload);
    });
    conn.virtualConnect("receiver-0");
    this.conn = conn;
    this.transportId = null;
    this.mediaSessionId = null;
    return conn;
  }

  private disconnect() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const conn = this.conn;
    this.conn = null;
    this.transportId = null;
    this.mediaSessionId = null;
    conn?.close();
  }

  private noteMedia(payload: CastPayload) {
    const first = (payload["status"] as MediaStatus[] | undefined)?.[0];
    if (first && typeof first.mediaSessionId === "number") this.mediaSessionId = first.mediaSessionId;
  }

  private async receiverStatus(conn: CastConnection): Promise<ReceiverStatus> {
    const reply = await conn.request(NS_RECEIVER, "receiver-0", { type: "GET_STATUS" });
    return (reply["status"] as ReceiverStatus | undefined) ?? {};
  }

  /** The transport id of the running media receiver, launching it if needed. */
  private async app(conn: CastConnection): Promise<string> {
    if (this.transportId) return this.transportId;
    let status = await this.receiverStatus(conn);
    let app = status.applications?.find((a) => a.appId === DEFAULT_MEDIA_RECEIVER);
    if (!app) {
      const reply = await conn.request(NS_RECEIVER, "receiver-0", { type: "LAUNCH", appId: DEFAULT_MEDIA_RECEIVER });
      if (reply.type === "LAUNCH_ERROR") throw new DeviceError("The Chromecast could not start its media player.");
      status = (reply["status"] as ReceiverStatus | undefined) ?? status;
      app = status.applications?.find((a) => a.appId === DEFAULT_MEDIA_RECEIVER);
    }
    if (!app) throw new DeviceError("The Chromecast did not start its media player.");
    conn.virtualConnect(app.transportId);
    this.transportId = app.transportId;
    return app.transportId;
  }

  async load(req: LoadRequest): Promise<void> {
    return this.serial(async () => {
      const conn = await this.connection();
      const transport = await this.app(conn);
      const images = req.artwork ? [{ url: req.artwork }] : undefined;
      const reply = await conn.request(NS_MEDIA, transport, {
        type: "LOAD",
        autoplay: req.autoplay,
        currentTime: req.startSec,
        media: {
          contentId: req.url,
          contentType: req.mime ?? "audio/mpeg",
          streamType: "BUFFERED",
          duration: req.durationSec,
          metadata: { metadataType: 3, title: req.title, artist: req.artist, albumName: req.album, images },
        },
      });
      if (reply.type === "LOAD_FAILED" || reply.type === "INVALID_REQUEST" || reply.type === "LOAD_CANCELLED") {
        throw new DeviceError("The Chromecast could not load this track.");
      }
      const status = (reply["status"] as MediaStatus[] | undefined)?.[0];
      if (status?.playerState === "IDLE" && status.idleReason === "ERROR") {
        throw new DeviceError("The Chromecast could not play this track. It may not support the file format.");
      }
      this.noteMedia(reply);
    });
  }

  private async mediaCommand(type: string, extra: Record<string, unknown> = {}): Promise<void> {
    return this.serial(async () => {
      const conn = await this.connection();
      const transport = await this.app(conn);
      if (this.mediaSessionId === null) {
        const reply = await conn.request(NS_MEDIA, transport, { type: "GET_STATUS" });
        this.noteMedia(reply);
      }
      if (this.mediaSessionId === null) throw new DeviceError("Nothing is playing on the Chromecast.");
      const reply = await conn.request(NS_MEDIA, transport, { type, mediaSessionId: this.mediaSessionId, ...extra });
      if (reply.type === "INVALID_REQUEST" || reply.type === "INVALID_PLAYER_STATE") {
        throw new DeviceError("The Chromecast did not accept that command.");
      }
      this.noteMedia(reply);
    });
  }

  pause = () => this.mediaCommand("PAUSE");
  resume = () => this.mediaCommand("PLAY");
  stop = () => this.mediaCommand("STOP");
  seek = (positionSec: number) => this.mediaCommand("SEEK", { currentTime: positionSec, resumeState: "PLAYBACK_START" });

  setVolume(level: number): Promise<void> {
    return this.serial(async () => {
      const conn = await this.connection();
      await conn.request(NS_RECEIVER, "receiver-0", { type: "SET_VOLUME", volume: { level: Math.min(1, Math.max(0, level)) } });
    });
  }

  status(): Promise<RendererStatus> {
    return this.serial(async () => {
      const conn = await this.connection();
      const receiver = await this.receiverStatus(conn);
      const app = receiver.applications?.find((a) => a.appId === DEFAULT_MEDIA_RECEIVER);
      const volume = receiver.volume?.level;
      if (!app) return { state: "stopped" as const, volume, muted: receiver.volume?.muted };
      if (this.transportId !== app.transportId) {
        conn.virtualConnect(app.transportId);
        this.transportId = app.transportId;
      }
      const reply = await conn.request(NS_MEDIA, app.transportId, { type: "GET_STATUS" });
      this.noteMedia(reply);
      const media = (reply["status"] as MediaStatus[] | undefined)?.[0];
      return {
        state: media ? (STATES[media.playerState ?? ""] ?? "unknown") : "stopped",
        positionSec: media?.currentTime,
        durationSec: media?.media?.duration,
        volume,
        muted: receiver.volume?.muted,
      };
    });
  }

  close(): void {
    this.disconnect();
  }
}
