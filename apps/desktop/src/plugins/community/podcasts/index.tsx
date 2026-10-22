import { useEffect, useMemo } from "react";
import type { Plugin } from "../../types";
import { usePlayer } from "@/player/playerStore";
import { useServer } from "../../builtins/server/serverStore";
import { stepSpeed } from "../_sourcekit/format";
import { MicIcon } from "../_sourcekit/icons";
import { PodcastSettings } from "./PodcastSettings";
import { PodcastsPage } from "./PodcastsPage";
import { activePlayback, connectQueue, episodeIdOf, episodeToTrack, resolveEpisode, usePodcasts } from "./podcastStore";

let watchingServer = false;
function followServerAccount() {
  if (watchingServer) return;
  watchingServer = true;
  useServer.subscribe((state, prev) => {
    if (state.user?.username === prev.user?.username) return;
    if (state.user) {
      void usePodcasts.getState().loadShows();
      void usePodcasts.getState().loadFresh();
    } else usePodcasts.getState().reset();
  });
}

/** Continue listening, on Home. */
function ContinueWidget() {
  const fresh = usePodcasts((s) => s.fresh);
  const playQueue = usePlayer((s) => s.playQueue);
  const items = useMemo(() => fresh.slice(0, 4), [fresh]);
  useEffect(() => {
    if (!usePodcasts.getState().freshLoaded && useServer.getState().user) void usePodcasts.getState().loadFresh();
  }, []);
  if (items.length === 0) return <p className="muted small">New episodes from your shows will show up here.</p>;
  return (
    <div className="sk-list">
      {items.map((e) => (
        <button key={e.id} className="sk-row" style={{ textAlign: "left", background: "none", border: 0, color: "inherit", font: "inherit", width: "100%", cursor: "pointer" }} onClick={() => void playQueue([episodeToTrack(e)], 0)}>
          <span className="sk-title" style={{ gridColumn: "1 / span 3" }}>
            {e.title}
            <span className="sk-sub">{e.feedTitle}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/** Podcasts: subscribe by search or feed address, with progress and speed that follow you between devices. */
const podcastsPlugin: Plugin = {
  manifest: {
    id: "cadence.podcasts",
    name: "Podcasts",
    version: "1.0.0",
    description:
      "Follow podcasts by RSS address or directory search. Your place in each episode, which ones you've played and each show's playback speed are saved on your server and follow you between devices. New episodes are checked for in the background.",
    author: "Cadence",
    capabilities: ["source.audio", "source.library", "ui.sidebar", "ui.settings", "ui.home.widget", "commands", "player.read", "player.queue", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    followServerAccount();
    if (useServer.getState().user) {
      void usePodcasts.getState().loadShows();
      void usePodcasts.getState().loadFresh();
    }
    connectQueue(
      (t) => ctx.player.enqueue(t),
      () => ctx.player.getState().queue.map((t) => t.id),
    );

    ctx.registerSidebarItem({ id: "podcasts", label: "Podcasts", icon: <MicIcon />, render: () => <PodcastsPage /> });
    ctx.registerSettingsPanel({
      id: "podcasts",
      title: "Podcasts",
      description: "Subscriptions, OPML import and export, directory.",
      icon: <MicIcon size={19} />,
      keywords: ["opml", "rss", "feed", "episodes", "podcast index", "itunes"],
      render: () => <PodcastSettings />,
    });
    ctx.registerHomeWidget({ id: "podcasts-new", title: "New podcast episodes", weight: 20, render: () => <ContinueWidget /> });

    ctx.registerAudioSource({
      id: "podcasts",
      label: "Podcasts",
      async resolve(track) {
        const id = episodeIdOf(track);
        if (!id || !useServer.getState().token) return null;
        return resolveEpisode(id);
      },
    });
    ctx.registerLibrarySource({
      id: "podcasts",
      label: "New podcast episodes",
      useTracks() {
        const fresh = usePodcasts((s) => s.fresh);
        return useMemo(() => fresh.map(episodeToTrack), [fresh]);
      },
    });

    const playing = () => {
      const c = ctx.player.getState().current;
      return c ? episodeIdOf(c) : null;
    };
    ctx.registerCommand({ id: "podcasts.faster", title: "Podcasts: playback faster", keywords: ["speed"], run: () => void usePodcasts.getState().changeSpeed(stepSpeed(activePlayback()?.handle.rate ?? 1, 1)) });
    ctx.registerCommand({ id: "podcasts.slower", title: "Podcasts: playback slower", keywords: ["speed"], run: () => void usePodcasts.getState().changeSpeed(stepSpeed(activePlayback()?.handle.rate ?? 1, -1)) });
    ctx.registerCommand({ id: "podcasts.back", title: "Podcasts: back 15 seconds", run: () => {
        if (playing()) ctx.player.seek(Math.max(0, ctx.player.getState().position - 15));
      },
    });
    ctx.registerCommand({ id: "podcasts.forward", title: "Podcasts: forward 30 seconds", run: () => {
        if (playing()) ctx.player.seek(ctx.player.getState().position + 30);
      },
    });
  },
};

export default podcastsPlugin;