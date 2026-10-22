import { useMemo, useState } from "react";
import { usePluginHost } from "@/plugins/host";
import type { LibrarySource } from "@/plugins/types";
import { primaryArtist } from "@/shared/types";
import { EmptyState } from "@/ui/EmptyState";
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
  // Don't pop the on-screen keyboard open just by visiting the tab on a phone.
  const autoFocus = typeof matchMedia === "function" ? !matchMedia("(pointer: coarse)").matches : true;

  return (
    <div className="view">
      <header className="view-header">
        <h1>Search</h1>
      </header>
      <div className="search-bar">
        <SearchIcon size={18} />
        <input
          type="search"
          autoFocus={autoFocus}
          placeholder="Songs, artists, albums…"
          aria-label="Search your library"
          enterKeyHint="search"
          autoComplete="off"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div style={{ marginTop: 24 }}>
        {term === "" ? (
          <EmptyState icon={<SearchIcon size={24} />} title="Find something to play">
            Search your songs, artists and albums across everything you've connected.
          </EmptyState>
        ) : (
          <>
            <div className="source-sections">
              {sources.map((source) => (
                <SourceResults key={source.id} source={source} term={term} />
              ))}
            </div>
            <div className="when-empty">
              <EmptyState icon={<SearchIcon size={24} />} title="No matches">
                Nothing found for “{q.trim()}”. Check the spelling or try a shorter search.
              </EmptyState>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
