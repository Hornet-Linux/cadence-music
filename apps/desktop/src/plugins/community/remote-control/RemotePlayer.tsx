import { useEffect, useRef, useState } from "react";
import { primaryArtist, formatDuration } from "@/shared/types";
import { CoverArt } from "@/ui/CoverArt";
import { NextIcon, PauseIcon, PlayIcon, PrevIcon, VolumeIcon } from "@/ui/icons";
import { chooseOutput, useOutput } from "../_devices/outputState";
import { estimatedPosition, sendRemoteCommand, useRemote } from "./remoteStore";
import { REMOTE_TARGET_ID } from "./target";
import type { RemoteCommand, RemoteDevice } from "./types";

/** Transport, position, volume and queue for one other player. */
export function RemotePlayer({ device }: { device: RemoteDevice }) {
  const receivedAt = useRemote((s) => s.receivedAt[device.id]);
  const active = useOutput((s) => s.active);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [drag, setDrag] = useState<number | null>(null);
  const volumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const s = device.state;
  const playing = s?.isPlaying === true;

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [playing]);

  const send = async (command: RemoteCommand) => {
    setError(null);
    try {
      await sendRemoteCommand(device.id, command);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Request failed \(\d+\):? ?/, "") || "That did not go through." : "That did not go through.");
    }
  };

  const position = drag ?? estimatedPosition(device, receivedAt, now);
  const duration = s?.duration || s?.track?.durationSec || 0;
  const hereIsControlling = active?.targetId === REMOTE_TARGET_ID && active.deviceId === device.id;

  return (
    <div className="card pad rc-player" aria-label={`Controlling ${device.name}`}>
      <div className="rc-now">
        <div className="rc-art">
          <CoverArt src={s?.track?.artwork} seed={s?.track?.album ?? s?.track?.title ?? device.name} label="" />
        </div>
        <div className="rc-text">
          <div className="rc-title">{s?.track ? s.track.title : "Nothing playing"}</div>
          <div className="rc-sub">{s?.track ? primaryArtist(s.track) : device.online ? `${device.name} is idle` : `${device.name} is offline`}</div>
        </div>
      </div>

      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      <div className="rc-seek">
        <span className="rc-time">{formatDuration(position)}</span>
        <input
          type="range"
          aria-label="Position"
          min={0}
          max={Math.max(1, Math.round(duration))}
          step={1}
          value={Math.min(Math.round(position), Math.max(1, Math.round(duration)))}
          disabled={!s?.track || !device.online}
          onChange={(e) => setDrag(Number(e.target.value))}
          onPointerUp={() => {
            if (drag !== null) void send({ type: "seek", position: drag });
            setDrag(null);
          }}
          onKeyUp={() => {
            if (drag !== null) void send({ type: "seek", position: drag });
            setDrag(null);
          }}
        />
        <span className="rc-time">{formatDuration(duration)}</span>
      </div>

      <div className="rc-transport">
        <button className="icon-btn rc-btn" aria-label="Previous" disabled={!device.online} onClick={() => void send({ type: "previous" })}>
          <PrevIcon size={22} />
        </button>
        <button className="icon-btn rc-btn rc-main" aria-label={playing ? "Pause" : "Play"} disabled={!device.online || !s?.track} onClick={() => void send({ type: playing ? "pause" : "play" })}>
          {playing ? <PauseIcon size={26} /> : <PlayIcon size={26} />}
        </button>
        <button className="icon-btn rc-btn" aria-label="Next" disabled={!device.online} onClick={() => void send({ type: "next" })}>
          <NextIcon size={22} />
        </button>
      </div>

      <label className="rc-volume">
        <VolumeIcon size={18} />
        <input
          type="range"
          aria-label="Volume"
          min={0}
          max={100}
          value={Math.round((s?.volume ?? 1) * 100)}
          disabled={!device.online}
          onChange={(e) => {
            const volume = Number(e.target.value) / 100;
            useRemote.getState().upsertDevice({ ...device, state: s ? { ...s, volume } : s });
            if (volumeTimer.current) clearTimeout(volumeTimer.current);
            volumeTimer.current = setTimeout(() => void send({ type: "volume", volume }), 200);
          }}
        />
      </label>

      <div className="rc-actions">
        {hereIsControlling ? (
          <button className="btn" onClick={() => void chooseOutput(null, null)}>
            Bring playback back here
          </button>
        ) : (
          <button className="btn primary" disabled={!device.online} onClick={() => void chooseOutput(REMOTE_TARGET_ID, device.id, device.name)}>
            Play my queue there
          </button>
        )}
      </div>

      {s && s.queue.length > 0 && (
        <details className="rc-queue">
          <summary>Queue ({s.queue.length})</summary>
          <ol>
            {s.queue.slice(0, 60).map((t, i) => (
              <li key={`${t.id}-${i}`}>
                <button className={`rc-qrow${i === s.index ? " current" : ""}`} disabled={!device.online} onClick={() => void send({ type: "queue.jump", index: i })}>
                  <span className="rc-qt">{t.title}</span>
                  <span className="rc-qa">{primaryArtist(t)}</span>
                </button>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
