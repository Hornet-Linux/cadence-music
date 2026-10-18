import { useMemo } from "react";
import { recentTracks, topTracks, useHistory } from "@/features/history/historyStore";
import { useOnboarding } from "@/features/onboarding/onboardingStore";
import { usePlayer } from "@/player/playerStore";
import { usePluginHost } from "@/plugins/host";
import type { LibrarySource } from "@/plugins/types";
import { primaryArtist, type Track } from "@/shared/types";
import { CoverArt } from "@/ui/CoverArt";
import { DiscIcon, FlameIcon, PlayIcon, SparkleIcon, TrophyIcon } from "@/ui/icons";
import { MediaCard, Shelf } from "@/ui/media";

const CARDS = 16;

function SourceShelf({ source }: { source: LibrarySource }) {
  const tracks = source.useTracks();
  if (tracks.length === 0) return null;
  return (
    <Shelf icon={<DiscIcon size={20} />} title={`From ${source.label}`}>
      {tracks.slice(0, CARDS).map((t) => (
        <MediaCard key={t.id} track={t} queue={tracks} />
      ))}
    </Shelf>
  );
}

/** Big banner for the most recent track, blurred from its own artwork. */
function Hero({ track, queue }: { track: Track; queue: Track[] }) {
  const playQueue = usePlayer((s) => s.playQueue);
  return (
    <section className="hero">
      <div className="hero-bg" aria-hidden>
        <CoverArt src={track.artwork} seed={track.album ?? track.title} showInitial={false} />
      </div>
      <div className="hero-art">
        <CoverArt src={track.artwork} seed={track.album ?? track.title} label={track.title} />
      </div>
      <div className="hero-text">
        <span className="eyebrow">Jump back in</span>
        <h2>{track.title}</h2>
        <p>
          {primaryArtist(track)}
          {track.album ? ` · ${track.album}` : ""}
        </p>
        <button className="btn primary big" onClick={() => void playQueue(queue, 0)}>
          <PlayIcon size={18} /> Play
        </button>
      </div>
    </section>
  );
}

function Welcome() {
  const startSetup = useOnboarding((s) => s.start);
  return (
    <section className="hero welcome">
      <div className="hero-text">
        <span className="eyebrow">Welcome</span>
        <h2>Your music, all in one place</h2>
        <p>Connect Spotify, Apple Music or your own server and your library and listening show up here.</p>
        <button className="btn primary big" onClick={startSetup}>
          <SparkleIcon size={16} /> Set up sources
        </button>
      </div>
    </section>
  );
}

export function HomeView() {
  const widgets = usePluginHost((s) => s.contributions.homeWidgets);
  const sources = usePluginHost((s) => s.contributions.librarySources);
  const plays = useHistory((s) => s.plays);
  const remoteTop = useHistory((s) => s.remoteTop);

  const recent = useMemo(() => recentTracks(plays, CARDS), [plays]);
  const top = useMemo(
    () =>
      remoteTop && remoteTop.length > 0
        ? remoteTop.map((t) => ({ track: t.track as Track, plays: t.plays }))
        : topTracks(plays, CARDS),
    [plays, remoteTop],
  );

  const hour = new Date().getHours();
  const greeting = hour < 5 ? "Up late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <div className="view home">
      <header className="view-header">
        <h1>{greeting}</h1>
      </header>

      {recent.length > 0 ? <Hero track={recent[0]} queue={recent} /> : <Welcome />}

      {recent.length > 0 && (
        <Shelf icon={<FlameIcon size={20} />} title="Listening right now">
          {recent.map((t) => (
            <MediaCard key={t.id} track={t} queue={recent} />
          ))}
        </Shelf>
      )}

      {top.length > 1 && (
        <Shelf icon={<TrophyIcon size={20} />} title="Most played">
          {top.map(({ track, plays: n }, i) => (
            <MediaCard
              key={track.id}
              track={track}
              queue={top.map((x) => x.track)}
              badge={i < 3 ? `#${i + 1}` : undefined}
              subtitle={`${primaryArtist(track)} · ${n} play${n === 1 ? "" : "s"}`}
            />
          ))}
        </Shelf>
      )}

      <div className="source-sections">
        {sources.map((source) => (
          <SourceShelf key={source.id} source={source} />
        ))}
      </div>

      {widgets.map((w) => (
        <section className="section" key={w.id}>
          <div className="section-head">
            <h2>
              <span className="section-icon">
                <SparkleIcon size={18} />
              </span>
              {w.title}
            </h2>
          </div>
          <div className="card pad">{w.render()}</div>
        </section>
      ))}
    </div>
  );
}
