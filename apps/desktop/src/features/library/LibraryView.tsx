import { useState } from "react";
import { usePluginHost } from "@/plugins/host";
import type { LibrarySource } from "@/plugins/types";
import { CollectionShelf } from "@/features/collection/CollectionUi";
import { usePlayer } from "@/player/playerStore";
import { PlayIcon, ShuffleIcon } from "@/ui/icons";
import { TrackRow } from "@/ui/media";

const PREVIEW = 200;

function SourceSection({ source }: { source: LibrarySource }) {
  const tracks = source.useTracks();
  const [showAll, setShowAll] = useState(false);
  const playQueue = usePlayer((s) => s.playQueue);
  const shuffle = usePlayer((s) => s.shuffle);
  const toggleShuffle = usePlayer((s) => s.toggleShuffle);
  if (tracks.length === 0) return null;
  const shown = showAll ? tracks : tracks.slice(0, PREVIEW);

  return (
    <section className="section">
      <div className="section-head">
        <h2>{source.label}</h2>
        <div className="section-tools">
          <span className="muted small">{tracks.length} tracks</span>
          <button className="icon-btn" aria-label={`Play ${source.label}`} data-tip="Play all" onClick={() => void playQueue(tracks, 0)}>
            <PlayIcon size={16} />
          </button>
          <button
            className="icon-btn"
            aria-label={`Shuffle ${source.label}`}
            data-tip="Shuffle"
            onClick={() => {
              if (!shuffle) toggleShuffle();
              void playQueue(tracks, Math.floor(Math.random() * tracks.length));
            }}
          >
            <ShuffleIcon size={16} />
          </button>
        </div>
      </div>
      <div className="track-list">
        {shown.map((t, i) => (
          <TrackRow key={t.id} track={t} index={i} queue={tracks} />
        ))}
      </div>
      {!showAll && tracks.length > PREVIEW && (
        <button className="btn ghost show-more" onClick={() => setShowAll(true)}>
          Show all {tracks.length}
        </button>
      )}
    </section>
  );
}

export function LibraryView() {
  const sources = usePluginHost((s) => s.contributions.librarySources);
  return (
    <div className="view">
      <header className="view-header">
        <h1>Your Library</h1>
        <p className="muted">Your playlists, liked songs and everything from your services, in one place.</p>
      </header>
      <CollectionShelf />
      <div className="source-sections">
        {sources.map((source) => (
          <SourceSection key={source.id} source={source} />
        ))}
      </div>
      <div className="card pad when-empty">
        <p className="muted">
          Your library is empty. Connect Spotify, Apple Music or your server in <strong>Settings</strong>, or add
          files under <strong>Local Files</strong>.
        </p>
      </div>
    </div>
  );
}
