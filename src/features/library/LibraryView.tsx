import { mockTracks } from "@/shared/mock";
import { TrackRow } from "@/ui/media";

export function LibraryView() {
  return (
    <div className="view">
      <header className="view-header">
        <h1>Your Library</h1>
        <p className="muted">
          Tracks you have saved. Connect a service or install a source plugin to fill this up.
        </p>
      </header>
      <div className="track-list">
        {mockTracks.map((t, i) => (
          <TrackRow key={t.id} track={t} index={i} queue={mockTracks} />
        ))}
      </div>
    </div>
  );
}
