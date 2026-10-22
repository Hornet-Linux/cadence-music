import { usePlayer } from "@/player/playerStore";
import type { Track } from "@/shared/types";
import type { OutputTarget, PlaybackEvent, PluginContext } from "../../types";
import { rendererApi, type PlayRequest, type RendererApi } from "./deviceApi";
import { friendlyError } from "./errors";
import { reportOutputLost, setOutputWarning, silenceLocal } from "./outputState";

export interface RendererTargetConfig {
  /** The OutputTarget id, e.g. "cadence.dlna". */
  id: string;
  label: string;
  /** Server route prefix: "dlna" or "chromecast". */
  prefix: string;
  pollMs?: number;
  api?: RendererApi;
}

interface Session {
  deviceId: string;
  deviceName: string;
  /** Last time we told the device to do something; polls right after are ignored while it catches up. */
  commandAt: number;
  /** Track last sent, so a repeated event does not restart it. */
  sentTrack: string | null;
  poll: ReturnType<typeof setInterval> | null;
  disagree: number;
  failures: number;
  unsubscribeVolume: (() => void) | null;
  volumeTimer: ReturnType<typeof setTimeout> | null;
  suppressSeekUntil: number;
}

const sessions = new Map<string, Session>();

export function playRequest(track: Track, positionSec: number, autoplay: boolean): PlayRequest {
  return {
    trackId: track.id,
    positionSec,
    autoplay,
    title: track.title,
    artist: track.artists.map((a) => a.name).join(", ") || undefined,
    album: track.album,
    artwork: track.artwork,
    durationSec: track.durationSec,
  };
}

/** Stop following a device: optionally tell it to stop, then give the sound back to this device. */
function endSession(targetId: string, api?: RendererApi): void {
  const session = sessions.get(targetId);
  if (!session) return;
  sessions.delete(targetId);
  if (session.poll) clearInterval(session.poll);
  if (session.volumeTimer) clearTimeout(session.volumeTimer);
  session.unsubscribeVolume?.();
  silenceLocal(false);
  if (api) void api.stop(session.deviceId).catch(() => undefined);
}

/**
 * Makes a server-side renderer plugin (DLNA, Chromecast) usable as a place to play. The local player keeps
 * running silently as the clock; every play, pause, seek, track change and volume change is sent on to the
 * device, and the device's own state is polled so pressing pause on the speaker also pauses here.
 */
export function createRendererTarget(ctx: PluginContext, cfg: RendererTargetConfig): OutputTarget {
  const api = cfg.api ?? rendererApi(cfg.prefix);
  const player = usePlayer;

  async function sendTrack(session: Session, position: number, autoplay: boolean): Promise<void> {
    const track = player.getState().current;
    session.commandAt = Date.now();
    if (!track) {
      session.sentTrack = null;
      await api.stop(session.deviceId).catch(() => undefined);
      return;
    }
    session.sentTrack = track.id;
    try {
      await api.play(session.deviceId, playRequest(track, position, autoplay));
      silenceLocal(true);
      setOutputWarning(null);
    } catch (err) {
      // A track the device cannot fetch (Spotify, local files) plays here instead; the output stays selected.
      silenceLocal(false);
      session.sentTrack = null;
      setOutputWarning(friendlyError(err, `Could not play this on ${session.deviceName}.`));
    }
  }

  ctx.onPlayback((event: PlaybackEvent) => {
    const session = sessions.get(cfg.id);
    if (!session) return;
    session.commandAt = Date.now();
    switch (event.kind) {
      case "track":
        if (event.track?.id !== session.sentTrack) void sendTrack(session, 0, true);
        break;
      case "play":
        if (session.sentTrack) void api.resume(session.deviceId).catch(() => undefined);
        break;
      case "pause":
        if (session.sentTrack) void api.pause(session.deviceId).catch(() => undefined);
        break;
      case "seek":
        if (Date.now() >= session.suppressSeekUntil && session.sentTrack) void api.seek(session.deviceId, event.position).catch(() => undefined);
        break;
      default:
        break;
    }
  });

  async function pollOnce(session: Session) {
    if (sessions.get(cfg.id) !== session) return;
    let status;
    try {
      status = await api.status(session.deviceId);
      session.failures = 0;
    } catch {
      session.failures++;
      if (session.failures >= 3) {
        endSession(cfg.id);
        reportOutputLost(cfg.id, `Lost contact with ${session.deviceName}. Playing on this device again.`);
      }
      return;
    }
    if (Date.now() - session.commandAt < 3500 || !session.sentTrack) return;
    const local = player.getState();
    const remotePlaying = status.state === "playing" || status.state === "buffering";
    // Pausing or stopping on the speaker itself should pause here too (two polls in a row, to ignore blips).
    const stoppedEarly = status.state === "stopped" && local.duration > 0 && local.position < local.duration - 4;
    const disagrees = (local.isPlaying && (status.state === "paused" || stoppedEarly)) || (!local.isPlaying && remotePlaying);
    session.disagree = disagrees ? session.disagree + 1 : 0;
    if (session.disagree >= 2) {
      session.disagree = 0;
      session.commandAt = Date.now();
      ctx.player.toggle();
      return;
    }
    // Keep the silent local clock close to the device so the next track starts when this one really ends.
    if (remotePlaying && local.isPlaying && status.positionSec !== undefined && Math.abs(status.positionSec - local.position) > 3) {
      session.suppressSeekUntil = Date.now() + 2000;
      ctx.player.seek(status.positionSec);
    }
  }

  return {
    id: cfg.id,
    label: cfg.label,
    async listDevices() {
      try {
        const list = await api.list(true);
        return list.devices.map((d) => ({ id: d.id, name: d.name }));
      } catch (err) {
        throw new Error(friendlyError(err, "Could not look for devices."));
      }
    },
    async select(deviceId) {
      endSession(cfg.id, deviceId === null ? api : undefined);
      if (deviceId === null) return;
      const list = await api.list().catch(() => null);
      const session: Session = {
        deviceId,
        deviceName: list?.devices.find((d) => d.id === deviceId)?.name ?? "the device",
        commandAt: Date.now(),
        sentTrack: null,
        poll: null,
        disagree: 0,
        failures: 0,
        unsubscribeVolume: null,
        volumeTimer: null,
        suppressSeekUntil: 0,
      };
      const state = player.getState();
      if (state.current) {
        // This has to work before the output is claimed; otherwise nothing would be audible anywhere.
        try {
          await api.play(deviceId, playRequest(state.current, state.position, state.isPlaying));
        } catch (err) {
          throw new Error(friendlyError(err, `Could not play on ${session.deviceName}.`));
        }
        session.sentTrack = state.current.id;
        silenceLocal(true);
      }
      sessions.set(cfg.id, session);
      let lastVolume = state.volume;
      session.unsubscribeVolume = player.subscribe((s) => {
        if (s.volume === lastVolume) return;
        lastVolume = s.volume;
        if (session.volumeTimer) clearTimeout(session.volumeTimer);
        session.volumeTimer = setTimeout(() => void api.setVolume(deviceId, s.volume).catch(() => undefined), 250);
      });
      session.poll = setInterval(() => void pollOnce(session), cfg.pollMs ?? 4000);
    },
  };
}

/** For tests: whether a target currently has a device it is following. */
export function hasSession(targetId: string): boolean {
  return sessions.has(targetId);
}
