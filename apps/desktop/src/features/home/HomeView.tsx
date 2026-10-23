import { useMemo, useState } from "react";
import { recentTracks, topTracks, useHistory } from "@/features/history/historyStore";
import { DjCard } from "@/features/dj/DjCard";
import { useOnboarding } from "@/features/onboarding/onboardingStore";
import { useSettingsModal } from "@/features/settings/settingsStore";
import { usePlayer } from "@/player/playerStore";
import { useServer } from "@/plugins/builtins/server/serverStore";
import { usePluginHost } from "@/plugins/host";
import type { HomeWidgetContribution, LibrarySource } from "@/plugins/types";
import { primaryArtist, type Track } from "@/shared/types";
import { CoverArt } from "@/ui/CoverArt";
import { EmptyState } from "@/ui/EmptyState";
import { DiscIcon, FlameIcon, NoteIcon, PlayIcon, SparkleIcon, TrophyIcon } from "@/ui/icons";
import { MediaCard, Shelf } from "@/ui/media";
import { isWebPlayer } from "@/ui/platform";
import { SkeletonShelf } from "@/ui/Skeleton";

const CARDS = 16;

function SourceShelf({ source }: { source: LibrarySource }) {
  const tracks = source.useTracks();
  if (tracks.length === 0) return null;
  return (
    <Shelf icon={<DiscIcon size={18} />} title={`From ${source.label}`}>
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

/**
 * Shown while nothing has been played and no source has any tracks. The
 * stylesheet hides it as soon as a source shelf appears (.source-sections).
 */
function NothingYet() {
  const startSetup = useOnboarding((s) => s.start);
  const showSettings = useSettingsModal((s) => s.show);
  const user = useServer((s) => s.user);
  const web = isWebPlayer();

  // The web player is served by the person's own server, so there is nothing to connect.
  if (web && user) {
    return (
      <EmptyState
        icon={<NoteIcon size={24} />}
        title="No music yet"
        action={
          <button className="btn primary" onClick={() => showSettings("server")}>
            Open server settings
          </button>
        }
      >
        Put music in your server's music folder, then rescan from Settings.
      </EmptyState>
    );
  }
  if (web) {
    return (
      <EmptyState
        icon={<NoteIcon size={24} />}
        title="Sign in to start listening"
        action={
          <button className="btn primary" onClick={() => showSettings("server")}>
            Sign in
          </button>
        }
      >
        Your music lives on your server. Sign in to see your library.
      </EmptyState>
    );
  }
  return (
    <EmptyState
      icon={<NoteIcon size={24} />}
      title="Your music, all in one place"
      action={
        <button className="btn primary" onClick={startSetup}>
          <SparkleIcon size={16} /> Set up sources
        </button>
      }
    >
      Connect Spotify, Apple Music, Jellyfin or your own server, or add files from this computer. What you play shows up
      here.
    </EmptyState>
  );
}

/** How many plugin widgets Home shows before folding the rest behind "Show more". */
export const HOME_WIDGET_LIMIT = 4;

/** Heaviest first; ties keep a stable alphabetical order so Home never reshuffles. */
export function orderWidgets(widgets: HomeWidgetContribution[]): HomeWidgetContribution[] {
  return [...widgets].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.title.localeCompare(b.title));
}

function HomeWidgets({ widgets }: { widgets: HomeWidgetContribution[] }) {
  const [all, setAll] = useState(false);
  const ordered = useMemo(() => orderWidgets(widgets), [widgets]);
  if (ordered.length === 0) return null;
  const shown = all ? ordered : ordered.slice(0, HOME_WIDGET_LIMIT);
  const hidden = ordered.length - shown.length;
  return (
    <div className="home-widgets">
      {shown.map((w) => (
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
      {(hidden > 0 || all) && ordered.length > HOME_WIDGET_LIMIT && (
        <button className="btn show-more" onClick={() => setAll(!all)} aria-expanded={all}>
          {all ? "Show fewer" : `Show ${hidden} more`}
        </button>
      )}
    </div>
  );
}

export function HomeView() {
  const widgets = usePluginHost((s) => s.contributions.homeWidgets);
  const sources = usePluginHost((s) => s.contributions.librarySources);
  const plays = useHistory((s) => s.plays);
  const remoteTop = useHistory((s) => s.remoteTop);
  const loadingLibrary = useServer((s) => s.loading && s.tracks.length === 0);

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

      {recent.length > 0 && <Hero track={recent[0]} queue={recent} />}

      <DjCard />

      {recent.length > 0 && (
        <Shelf icon={<FlameIcon size={18} />} title="Listening right now">
          {recent.map((t) => (
            <MediaCard key={t.id} track={t} queue={recent} />
          ))}
        </Shelf>
      )}

      {top.length > 1 && (
        <Shelf icon={<TrophyIcon size={18} />} title="Most played">
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

      {loadingLibrary && <SkeletonShelf label="Loading your library" />}

      <div className="source-sections">
        {sources.map((source) => (
          <SourceShelf key={source.id} source={source} />
        ))}
      </div>

      {recent.length === 0 && !loadingLibrary && (
        <div className="home-empty">
          <NothingYet />
        </div>
      )}

      <HomeWidgets widgets={widgets} />
    </div>
  );
}
