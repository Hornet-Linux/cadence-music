import { useRef, useState } from "react";
import { useUi } from "@/app/uiStore";
import { usePlayer } from "@/player/playerStore";
import { formatDuration, primaryArtist } from "@/shared/types";
import { CoverArt } from "./CoverArt";
import {
  MuteIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  QueueIcon,
  RepeatIcon,
  ShuffleIcon,
  VolumeIcon,
} from "./icons";

/** Click or drag to set a value between 0 and max. */
function Scrub({
  value,
  max,
  onSeek,
  label,
}: {
  value: number;
  max: number;
  onSeek: (v: number) => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? value;
  const pct = max > 0 ? Math.min(100, (shown / max) * 100) : 0;

  const valueAt = (clientX: number) => {
    const rect = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * max;
  };

  return (
    <div
      ref={ref}
      className={`scrub${dragging !== null ? " dragging" : ""}`}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.round(shown)}
      tabIndex={0}
      onPointerDown={(e) => {
        if (max <= 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(valueAt(e.clientX));
      }}
      onPointerMove={(e) => {
        if (dragging !== null) setDragging(valueAt(e.clientX));
      }}
      onPointerUp={(e) => {
        if (dragging === null) return;
        onSeek(valueAt(e.clientX));
        setDragging(null);
      }}
      onKeyDown={(e) => {
        const step = max / 20;
        if (e.key === "ArrowRight") onSeek(Math.min(max, value + step));
        if (e.key === "ArrowLeft") onSeek(Math.max(0, value - step));
      }}
    >
      <div className="track-bg">
        <div className="fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="thumb" style={{ left: `${pct}%` }} />
    </div>
  );
}

export function PlayerBar() {
  const p = usePlayer();
  const queueOpen = useUi((s) => s.queueOpen);
  const toggleQueue = useUi((s) => s.toggleQueue);
  const duration = p.duration || p.current?.durationSec || 0;

  return (
    <footer className="playerbar">
      <div className="np">
        {p.current ? (
          <>
            <div className="art">
              <CoverArt src={p.current.artwork} seed={p.current.album ?? p.current.title} label={p.current.title} />
            </div>
            <div className="names">
              <div className="tt" title={p.current.title}>
                {p.current.title}
              </div>
              <div className={`ta${p.unresolved ? " warn" : ""}`}>
                {p.unresolved ? "Can't play this right now — check the source in Settings" : primaryArtist(p.current)}
              </div>
            </div>
          </>
        ) : (
          <span className="empty">Pick something to play</span>
        )}
      </div>

      <div className="transport">
        <div className="buttons">
          <button className={`ctrl${p.shuffle ? " active" : ""}`} aria-label="Shuffle" onClick={p.toggleShuffle}>
            <ShuffleIcon size={18} />
          </button>
          <button className="ctrl" aria-label="Previous track" onClick={() => void p.previous()}>
            <PrevIcon size={20} />
          </button>
          <button
            className="ctrl play"
            aria-label={p.isPlaying ? "Pause" : "Play"}
            onClick={p.toggle}
            disabled={!p.current}
          >
            {p.isPlaying ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
          </button>
          <button className="ctrl" aria-label="Next track" onClick={() => void p.next()}>
            <NextIcon size={20} />
          </button>
          <button
            className={`ctrl${p.repeat !== "off" ? " active" : ""}`}
            aria-label={`Repeat: ${p.repeat}`}
            onClick={p.cycleRepeat}
          >
            <RepeatIcon size={18} />
            {p.repeat === "one" && <span className="repeat-one">1</span>}
          </button>
        </div>
        <div className="seek">
          <span className="time">{formatDuration(p.position)}</span>
          <Scrub value={p.position} max={duration} onSeek={p.seek} label="Seek" />
          <span className="time">{formatDuration(duration)}</span>
        </div>
      </div>

      <div className="player-right">
        <button
          className={`ctrl${queueOpen ? " active" : ""}`}
          aria-label="Queue"
          aria-pressed={queueOpen}
          onClick={toggleQueue}
        >
          <QueueIcon size={19} />
        </button>
        <div className="volume">
          <button className="ctrl" aria-label={p.muted ? "Unmute" : "Mute"} onClick={p.toggleMute}>
            {p.muted || p.volume === 0 ? <MuteIcon size={18} /> : <VolumeIcon size={18} />}
          </button>
          <Scrub value={p.muted ? 0 : p.volume} max={1} onSeek={p.setVolume} label="Volume" />
        </div>
      </div>
    </footer>
  );
}
