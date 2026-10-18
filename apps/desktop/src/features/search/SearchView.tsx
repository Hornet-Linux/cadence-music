import { useMemo, useState } from "react";
import { usePluginHost } from "@/plugins/host";
import type { LibrarySource } from "@/plugins/types";
import { primaryArtist } from "@/shared/types";
import { SearchIcon } from "@/ui/icons";
import { TrackRow } from "@/ui/media";

const MAX_RESULTS = 100;

function SourceResults({ source, term }: { source: LibrarySource; term: string }) {
  const tracks = source.useTracks();
  const results = useMemo(
    () =>
      tracks
        .filter(
          (t) =>
            t.title.toLowerCase().includes(term) ||
            primaryArtist(t).toLowerCase().includes(term) ||
            (t.album?.toLowerCase().includes(term) ?? false),
        )
        .slice(0, MAX_RESULTS),
    [tracks, term],
  );
  if (results.length === 0) return null;
  return (
    <section className="section">
      <div className="section-head">
        <h2>{source.label}</h2>
        <span className="muted small">{results.length} matches</span>
      </div>
      <div className="track-list">
        {results.map((t, i) => (
          <TrackRow key={t.id} track={t} index={i} queue={results} />
        ))}
      </div>
    </section>
  );
}

export function SearchView() {
  const sources = usePluginHost((s) => s.contributions.librarySources);
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();

  return (
    <div className="view">
      <header className="view-header">
        <h1>Search</h1>
      </header>
      <div className="search-bar">
        <SearchIcon size={18} />
        <input
          autoFocus
          placeholder="Songs, artists, albums…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div style={{ marginTop: 24 }}>
        {term === "" ? (
          <p className="empty">Search your server and local files.</p>
        ) : (
          <>
            <div className="source-sections">
              {sources.map((source) => (
                <SourceResults key={source.id} source={source} term={term} />
              ))}
            </div>
            <p className="empty when-empty">No matches for “{q.trim()}”.</p>
          </>
        )}
      </div>
    </div>
  );
}
