import { useState } from "react";
import { usePluginHost } from "@/plugins/host";
import type { LibrarySource } from "@/plugins/types";
import { TrackRow } from "@/ui/media";

const PREVIEW = 200;

function SourceSection({ source }: { source: LibrarySource }) {
  const tracks = source.useTracks();
  const [showAll, setShowAll] = useState(false);
  if (tracks.length === 0) return null;
  const shown = showAll ? tracks : tracks.slice(0, PREVIEW);

  return (
    <section className="section">
      <div className="section-head">
        <h2>{source.label}</h2>
        <span className="muted small">{tracks.length} tracks</span>
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
        <p className="muted">Everything from your server and local files, in one place.</p>
      </header>
      <div className="source-sections">
        {sources.map((source) => (
          <SourceSection key={source.id} source={source} />
        ))}
      </div>
      <div className="card pad when-empty">
        <p className="muted">
          Your library is empty. Connect your server in <strong>Settings → Server</strong>, or add
          files under <strong>Local Files</strong>.
        </p>
      </div>
    </div>
  );
}
