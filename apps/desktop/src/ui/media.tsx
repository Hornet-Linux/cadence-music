import { useRef, type ReactNode } from "react";
import { usePrefs } from "@/features/preferences/prefsStore";
import { usePlayer } from "@/player/playerStore";
import { formatDuration, primaryArtist, type Track } from "@/shared/types";
import { CoverArt } from "./CoverArt";
import { PauseIcon, PlayIcon, PlusIcon } from "./icons";

function useIsCurrent(track: Track) {
  return usePlayer((s) => s.current?.id === track.id);
}

/** Large artwork card for shelves. */
export function MediaCard({
  track,
  queue,
  subtitle,
  badge,
}: {
  track: Track;
  queue?: Track[];
  subtitle?: string;
  badge?: ReactNode;
}) {
  const playQueue = usePlayer((s) => s.playQueue);
  const toggle = usePlayer((s) => s.toggle);
  const isPlaying = usePlayer((s) => s.isPlaying);
  const isCurrent = useIsCurrent(track);
  const list = queue ?? [track];
  const start = Math.max(0, list.findIndex((t) => t.id === track.id));
  const play = () => (isCurrent ? toggle() : void playQueue(list, start));

  return (
    <div className={`media-card${isCurrent ? " current" : ""}`}>
      <button className="art" onClick={play} aria-label={`Play ${track.title}`}>
        <CoverArt src={track.artwork} seed={track.album ?? track.title} label={track.title} />
        {badge && <span className="card-badge">{badge}</span>}
        <span className="play-fab">{isCurrent && isPlaying ? <PauseIcon size={18} /> : <PlayIcon size={18} />}</span>
      </button>
      <div className="title" title={track.title}>
        {track.title}
      </div>
      <div className="subtitle" title={subtitle ?? primaryArtist(track)}>
        {subtitle ?? primaryArtist(track)}
      </div>
    </div>
  );
}

/** A song in a list. Double-click plays or queues (see Settings → Playback). */
export function TrackRow({
  track,
  index,
  queue,
  showAlbum = true,
}: {
  track: Track;
  index: number;
  queue: Track[];
  showAlbum?: boolean;
}) {
  const playQueue = usePlayer((s) => s.playQueue);
  const addToQueue = usePlayer((s) => s.addToQueue);
  const isPlaying = usePlayer((s) => s.isPlaying);
  const toggle = usePlayer((s) => s.toggle);
  const doubleClick = usePrefs((s) => s.doubleClick);
  const isCurrent = useIsCurrent(track);
  const play = () => (isCurrent ? toggle() : void playQueue(queue, index));

  return (
    <div
      className={`track-row${isCurrent ? " playing" : ""}`}
      role="row"
      tabIndex={0}
      onDoubleClick={() => (doubleClick === "queue" ? addToQueue(track) : play())}
      onKeyDown={(e) => {
        if (e.key === "Enter") play();
      }}
    >
      <span className="idx">
        <span className="num">{isCurrent && isPlaying ? <span className="eq" aria-hidden /> : index + 1}</span>
        <button className="row-play" onClick={play} aria-label={`Play ${track.title}`}>
          {isCurrent && isPlaying ? <PauseIcon size={15} /> : <PlayIcon size={15} />}
        </button>
      </span>
      <span className="meta">
        <span className="mini-art">
          <CoverArt src={track.artwork} seed={track.album ?? track.title} label={track.title} showInitial={false} />
        </span>
        <span className="names">
          <span className="tt">{track.title}</span>
          <span className="ta">{primaryArtist(track)}</span>
        </span>
      </span>
      {showAlbum && <span className="album">{track.album ?? ""}</span>}
      <span className="row-actions">
        <button
          className="icon-btn"
          onClick={() => addToQueue(track)}
          aria-label={`Add ${track.title} to queue`}
          data-tip="Add to queue"
        >
          <PlusIcon size={16} />
        </button>
      </span>
      <span className="dur">{formatDuration(track.durationSec)}</span>
    </div>
  );
}

/** Section heading with an accent icon. */
export function SectionHeader({ icon, title, action }: { icon?: ReactNode; title: string; action?: ReactNode }) {
  return (
    <div className="section-head">
      <h2>
        {icon && <span className="section-icon">{icon}</span>}
        {title}
      </h2>
      {action}
    </div>
  );
}

/** A horizontally scrolling row of cards with arrow buttons. */
export function Shelf({ icon, title, children }: { icon?: ReactNode; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const scroll = (dir: number) =>
    ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.8, behavior: "smooth" });
  return (
    <section className="section shelf">
      <SectionHeader
        icon={icon}
        title={title}
        action={
          <div className="shelf-arrows">
            <button className="icon-btn" onClick={() => scroll(-1)} aria-label={`Scroll ${title} left`}>
              ‹
            </button>
            <button className="icon-btn" onClick={() => scroll(1)} aria-label={`Scroll ${title} right`}>
              ›
            </button>
          </div>
        }
      />
      <div className="shelf-row" ref={ref}>
        {children}
      </div>
    </section>
  );
}
