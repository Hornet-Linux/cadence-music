import { useUi } from "@/app/uiStore";
import { usePlayer } from "@/player/playerStore";
import { primaryArtist, type Track } from "@/shared/types";
import { CoverArt } from "./CoverArt";
import { CloseIcon } from "./icons";

function QueueItem({
  track,
  label,
  onPlay,
  onRemove,
  current,
}: {
  track: Track;
  label: string;
  onPlay: () => void;
  onRemove?: () => void;
  current?: boolean;
}) {
  return (
    <div className={`queue-item${current ? " current" : ""}`}>
      <button className="queue-main" onClick={onPlay} aria-label={label}>
        <span className="mini-art">
          <CoverArt src={track.artwork} seed={track.album ?? track.title} label={track.title} showInitial={false} />
        </span>
        <span className="names">
          <span className="tt">{track.title}</span>
          <span className="ta">{primaryArtist(track)}</span>
        </span>
      </button>
      {onRemove && (
        <button className="icon-btn" onClick={onRemove} aria-label={`Remove ${track.title} from queue`}>
          <CloseIcon />
        </button>
      )}
    </div>
  );
}

/** Slide-over panel listing what's playing and what's next. */
export function QueueDrawer() {
  const open = useUi((s) => s.queueOpen);
  const close = useUi((s) => s.closeQueue);
  const { queue, index, jumpTo, removeFromQueue } = usePlayer();
  const current = index >= 0 ? queue[index] : undefined;
  const upNext = queue.slice(index + 1);

  return (
    <aside className={`queue-drawer${open ? " open" : ""}`} aria-hidden={!open} aria-label="Queue">
      <header>
        <h2>Queue</h2>
        <button className="icon-btn" onClick={close} aria-label="Close queue">
          <CloseIcon />
        </button>
      </header>
      <div className="queue-body">
        <div className="queue-label">Now playing</div>
        {current ? (
          <QueueItem track={current} label={`Playing ${current.title}`} onPlay={() => void jumpTo(index)} current />
        ) : (
          <p className="empty">Nothing is playing.</p>
        )}
        <div className="queue-label">Next up · {upNext.length}</div>
        {upNext.length === 0 ? (
          <p className="empty">Add songs with the + button or by double-clicking.</p>
        ) : (
          upNext.map((t, i) => (
            <QueueItem
              key={`${t.id}-${index + 1 + i}`}
              track={t}
              label={`Play ${t.title}`}
              onPlay={() => void jumpTo(index + 1 + i)}
              onRemove={() => removeFromQueue(index + 1 + i)}
            />
          ))
        )}
      </div>
    </aside>
  );
}
