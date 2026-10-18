import { useMemo, useState } from "react";
import { mockTracks } from "@/shared/mock";
import { primaryArtist } from "@/shared/types";
import { SearchIcon } from "@/ui/icons";
import { TrackRow } from "@/ui/media";

export function SearchView() {
  const [q, setQ] = useState("");
  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    return mockTracks.filter(
      (t) => t.title.toLowerCase().includes(term) || primaryArtist(t).toLowerCase().includes(term),
    );
  }, [q]);

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

      <section className="section" style={{ marginTop: 24 }}>
        {q.trim() === "" ? (
          <p className="empty">Start typing to search your library and connected sources.</p>
        ) : results.length === 0 ? (
          <p className="empty">No matches for “{q}”.</p>
        ) : (
          <div className="track-list">
            {results.map((t, i) => (
              <TrackRow key={t.id} track={t} index={i} queue={results} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
