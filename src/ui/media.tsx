import { usePlayer } from "@/player/playerStore";
import { formatDuration, primaryArtist, type Track } from "@/shared/types";
import { CoverArt } from "./CoverArt";
import { PlayIcon } from "./icons";

export function MediaCard({ track, queue }: { track: Track; queue?: Track[] }) {
  const playQueue = usePlayer((s) => s.playQueue);
  const list = queue ?? [track];
  const start = Math.max(0, list.findIndex((t) => t.id === track.id));
  return (
    <button className="media-card" onClick={() => void playQueue(list, start)}>
      <div className="art">
        <CoverArt seed={track.album ?? track.title} label={track.title} />
        <span className="play-fab">
          <PlayIcon size={18} />
        </span>
      </div>
      <div className="title">{track.title}</div>
      <div className="subtitle">{primaryArtist(track)}</div>
    </button>
  );
}

export function TrackRow({ track, index, queue }: { track: Track; index: number; queue: Track[] }) {
  const playQueue = usePlayer((s) => s.playQueue);
  const current = usePlayer((s) => s.current);
  const isCurrent = current?.id === track.id;
  return (
    <button
      className={`track-row${isCurrent ? " playing" : ""}`}
      onClick={() => void playQueue(queue, index)}
    >
      <span className="idx">{index + 1}</span>
      <span className="meta">
        <span className="mini-art">
          <CoverArt seed={track.album ?? track.title} label={track.title} showInitial={false} />
        </span>
        <span className="names">
          <span className="tt">{track.title}</span>
          <span className="ta">{primaryArtist(track)}</span>
        </span>
      </span>
      <span className="dur">{formatDuration(track.durationSec)}</span>
    </button>
  );
}
