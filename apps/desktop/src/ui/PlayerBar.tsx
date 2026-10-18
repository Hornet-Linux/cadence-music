import { useEffect, useRef, useState } from "react";
import { useUi } from "@/app/uiStore";
import { usePlayer } from "@/player/playerStore";
import { formatDuration, primaryArtist } from "@/shared/types";
import { LikeButton } from "./CollectionButtons";
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

// Each part of the bar subscribes only to the player state it shows, so a
// position tick re-renders the seek bar and nothing else.

/** Click or drag to set a value between 0 and max. */
function Scrub({
  value,
  max,
  onSeek,
  label,
  onDrag,
}: {
  value: number;
  max: number;
  onSeek: (v: number) => void;
  label: string;
  /** Called with the dragged value, or null when the drag ends. */
  onDrag?: (v: number | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? value;
  const pct = max > 0 ? Math.min(100, (shown / max) * 100) : 0;

  const valueAt = (clientX: number) => {
    const rect = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * max;
  };
  const drag = (v: number | null) => {
    setDragging(v);
    onDrag?.(v);
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
        drag(valueAt(e.clientX));
      }}
      onPointerMove={(e) => {
        if (dragging !== null) drag(valueAt(e.clientX));
      }}
      onPointerUp={(e) => {
        if (dragging === null) return;
        onSeek(valueAt(e.clientX));
        drag(null);
      }}
      onPointerCancel={() => drag(null)}
      onKeyDown={(e) => {
        const step = max / 20;
        if (e.key === "ArrowRight") onSeek(Math.min(max, value + step));
        if (e.key === "ArrowLeft") onSeek(Math.max(0, value - step));
      }}
    >
      <div className="track-bg">
        <div className="fill" style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
      <div className="thumb" style={{ left: `${pct}%` }} />
    </div>
  );
}

/**
 * The playback position, advanced every animation frame between the player's
 * own updates (which arrive only a few times a second), so the bar glides
 * instead of stepping.
 */
function useSmoothPosition(): number {
  const [shown, setShown] = useState(() => usePlayer.getState().position);
  useEffect(() => {
    let anchor = { position: usePlayer.getState().position, at: performance.now() };
    let frame = 0;
    const tick = () => {
      const { isPlaying, duration } = usePlayer.getState();
      // Never run more than a moment ahead of the last real update.
      const elapsed = isPlaying ? Math.min((performance.now() - anchor.at) / 1000, 1.5) : 0;
      const next = anchor.position + elapsed;
      setShown(duration > 0 ? Math.min(next, duration) : next);
      frame = isPlaying ? requestAnimationFrame(tick) : 0;
    };
    const unsubscribe = usePlayer.subscribe((state, prev) => {
      if (state.position !== prev.position || state.isPlaying !== prev.isPlaying || state.current !== prev.current) {
        anchor = { position: state.position, at: performance.now() };
        if (!frame) tick();
      }
    });
    tick();
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
    };
  }, []);
  return shown;
}

function SeekBar() {
  const position = useSmoothPosition();
  const duration = usePlayer((s) => s.duration || s.current?.durationSec || 0);
  const seek = usePlayer((s) => s.seek);
  const [dragged, setDragged] = useState<number | null>(null);
  return (
    <div className="seek">
      <span className="time">{formatDuration(dragged ?? position)}</span>
      <Scrub value={position} max={duration} onSeek={seek} onDrag={setDragged} label="Seek" />
      <span className="time">{formatDuration(duration)}</span>
    </div>
  );
}

function NowPlaying() {
  const current = usePlayer((s) => s.current);
  const unresolved = usePlayer((s) => s.unresolved);
  if (!current) {
    return (
      <div className="np">
        <span className="empty">Pick something to play</span>
      </div>
    );
  }
  // Keyed by track so the artwork and names fade in when the song changes.
  return (
    <div className="np">
      <div className="art np-swap" key={current.id}>
        <CoverArt src={current.artwork} seed={current.album ?? current.title} label={current.title} />
      </div>
      <div className="names np-swap" key={`${current.id}:names`}>
        <div className="tt" title={current.title}>
          {current.title}
        </div>
        <div className={`ta${unresolved ? " warn" : ""}`}>
          {unresolved ? "Can't play this right now — check the source in Settings" : primaryArtist(current)}
        </div>
      </div>
      <LikeButton track={current} size={18} />
    </div>
  );
}

function Transport() {
  const isPlaying = usePlayer((s) => s.isPlaying);
  const hasTrack = usePlayer((s) => !!s.current);
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  const p = usePlayer.getState;
  return (
    <div className="buttons">
      <button className={`ctrl${shuffle ? " active" : ""}`} aria-label="Shuffle" onClick={() => p().toggleShuffle()}>
        <ShuffleIcon size={18} />
      </button>
      <button className="ctrl" aria-label="Previous track" onClick={() => void p().previous()}>
        <PrevIcon size={20} />
      </button>
      <button
        className="ctrl play"
        aria-label={isPlaying ? "Pause" : "Play"}
        onClick={() => p().toggle()}
        disabled={!hasTrack}
      >
        {isPlaying ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
      </button>
      <button className="ctrl" aria-label="Next track" onClick={() => void p().next()}>
        <NextIcon size={20} />
      </button>
      <button
        className={`ctrl${repeat !== "off" ? " active" : ""}`}
        aria-label={`Repeat: ${repeat}`}
        onClick={() => p().cycleRepeat()}
      >
        <RepeatIcon size={18} />
        {repeat === "one" && <span className="repeat-one">1</span>}
      </button>
    </div>
  );
}

function Volume() {
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const toggleMute = usePlayer((s) => s.toggleMute);
  const setVolume = usePlayer((s) => s.setVolume);
  return (
    // Scrolling over the volume control nudges it, like most players.
    <div className="volume" onWheel={(e) => setVolume(Math.min(1, Math.max(0, volume - Math.sign(e.deltaY) * 0.05)))}>
      <button className="ctrl" aria-label={muted ? "Unmute" : "Mute"} onClick={toggleMute}>
        {muted || volume === 0 ? <MuteIcon size={18} /> : <VolumeIcon size={18} />}
      </button>
      <Scrub value={muted ? 0 : volume} max={1} onSeek={setVolume} label="Volume" />
    </div>
  );
}

export function PlayerBar() {
  const queueOpen = useUi((s) => s.queueOpen);
  const toggleQueue = useUi((s) => s.toggleQueue);

  return (
    <footer className="playerbar">
      <NowPlaying />
      <div className="transport">
        <Transport />
        <SeekBar />
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
        <Volume />
      </div>
    </footer>
  );
}
