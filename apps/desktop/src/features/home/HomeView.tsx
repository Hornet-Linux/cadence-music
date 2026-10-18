import { usePluginHost } from "@/plugins/host";
import type { LibrarySource } from "@/plugins/types";
import { MediaCard } from "@/ui/media";

const CARDS = 12;

function SourceShelf({ source }: { source: LibrarySource }) {
  const tracks = source.useTracks();
  if (tracks.length === 0) return null;
  const shelf = tracks.slice(0, CARDS);
  return (
    <section className="section">
      <div className="section-head">
        <h2>From {source.label.toLowerCase()}</h2>
      </div>
      <div className="card-grid">
        {shelf.map((t) => (
          <MediaCard key={t.id} track={t} queue={tracks} />
        ))}
      </div>
    </section>
  );
}

export function HomeView() {
  const widgets = usePluginHost((s) => s.contributions.homeWidgets);
  const sources = usePluginHost((s) => s.contributions.librarySources);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <div className="view">
      <header className="view-header">
        <h1>{greeting}</h1>
      </header>

      <div className="source-sections">
        {sources.map((source) => (
          <SourceShelf key={source.id} source={source} />
        ))}
      </div>

      {widgets.map((w) => (
        <section className="section" key={w.id}>
          <div className="section-head">
            <h2>{w.title}</h2>
          </div>
          <div className="card pad">{w.render()}</div>
        </section>
      ))}
    </div>
  );
}
