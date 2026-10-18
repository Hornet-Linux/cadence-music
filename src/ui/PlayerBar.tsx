import { usePlayer } from "@/player/playerStore";
import { formatDuration, primaryArtist } from "@/shared/types";
import { CoverArt } from "./CoverArt";
import {
  MuteIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  RepeatIcon,
  ShuffleIcon,
  VolumeIcon,
} from "./icons";

function Scrub({ value, max, onSeek }: { value: number; max: number; onSeek: (v: number) => void }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div
      className="scrub"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / rect.width;
        onSeek(Math.min(1, Math.max(0, ratio)) * max);
      }}
    >
      <div className="fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function PlayerBar() {
  const p = usePlayer();

  return (
    <footer className="playerbar">
      <div className="np">
        {p.current ? (
          <>
            <div className="art">
              <CoverArt seed={p.current.album ?? p.current.title} label={p.current.title} />
            </div>
            <div className="names">
              <div className="tt">{p.current.title}</div>
              <div className="ta">
                {p.unresolved ? "No source plugin can play this yet" : primaryArtist(p.current)}
              </div>
            </div>
          </>
        ) : (
          <span className="empty">Nothing playing</span>
        )}
      </div>

      <div className="transport">
        <div className="buttons">
          <button
            className={`ctrl${p.shuffle ? " active" : ""}`}
            aria-label="Shuffle"
            onClick={p.toggleShuffle}
          >
            <ShuffleIcon size={18} />
          </button>
          <button className="ctrl" aria-label="Previous" onClick={() => void p.previous()}>
            <PrevIcon size={20} />
          </button>
          <button className="ctrl play" aria-label={p.isPlaying ? "Pause" : "Play"} onClick={p.toggle}>
            {p.isPlaying ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
          </button>
          <button className="ctrl" aria-label="Next" onClick={() => void p.next()}>
            <NextIcon size={20} />
          </button>
          <button
            className={`ctrl${p.repeat !== "off" ? " active" : ""}`}
            aria-label="Repeat"
            onClick={p.cycleRepeat}
            title={`Repeat: ${p.repeat}`}
          >
            <RepeatIcon size={18} />
          </button>
        </div>
        <div className="seek">
          <span className="time">{formatDuration(p.position)}</span>
          <Scrub value={p.position} max={p.duration} onSeek={p.seek} />
          <span className="time">{formatDuration(p.duration || p.current?.durationSec)}</span>
        </div>
      </div>

      <div className="player-right">
        <div className="volume">
          <button className="ctrl" aria-label="Mute" onClick={p.toggleMute}>
            {p.muted || p.volume === 0 ? <MuteIcon size={18} /> : <VolumeIcon size={18} />}
          </button>
          <Scrub value={p.muted ? 0 : p.volume} max={1} onSeek={p.setVolume} />
        </div>
      </div>
    </footer>
  );
}
