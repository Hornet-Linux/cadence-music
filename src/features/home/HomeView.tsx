import { usePluginHost } from "@/plugins/host";
import { madeForYou, recentlyPlayed } from "@/shared/mock";
import { MediaCard } from "@/ui/media";

export function HomeView() {
  const widgets = usePluginHost((s) => s.contributions.homeWidgets);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <div className="view">
      <header className="view-header">
        <h1>{greeting}</h1>
      </header>

      {widgets.map((w) => (
        <section className="section" key={w.id}>
          <div className="section-head">
            <h2>{w.title}</h2>
          </div>
          <div className="card pad">{w.render()}</div>
        </section>
      ))}

      <section className="section">
        <div className="section-head">
          <h2>Recently played</h2>
        </div>
        <div className="card-grid">
          {recentlyPlayed.map((t) => (
            <MediaCard key={t.id} track={t} queue={recentlyPlayed} />
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Made for you</h2>
        </div>
        <div className="card-grid">
          {madeForYou.map((t) => (
            <MediaCard key={t.id} track={t} queue={madeForYou} />
          ))}
        </div>
      </section>
    </div>
  );
}
