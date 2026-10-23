import { useNav } from "@/app/navStore";
import type { Plugin } from "../../types";
import { LyricsPage } from "./LyricsPage";
import { startLyricsView, stopLyricsView, useLyricsView } from "./lyricsStore";
import "./style.css";

function LyricsIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 6h16M4 11h10M4 16h7" />
      <path d="M17 14v5.2M17 14l3-.8v4.6" />
      <circle cx="15.6" cy="19.2" r="1.4" />
    </svg>
  );
}

/**
 * The Lyrics page: follows the playing track, shows synced lyrics from whichever lyrics provider
 * plugins are enabled, scrolls with the song, and has a full-screen karaoke mode. Other plugins
 * (such as translation) join in through ./api.
 */
const plugin: Plugin = {
  manifest: {
    id: "cadence.lyrics-view",
    name: "Lyrics page",
    version: "1.0.0",
    description:
      "A Lyrics page that follows the playing song with synced highlighting, tap-to-seek, text size, source choice and a full-screen karaoke mode. Needs a lyrics source plugin, such as Lyrics from LRCLIB.",
    author: "Cadence",
    capabilities: ["ui.sidebar", "player.read", "player.control", "storage", "commands"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    try {
      startLyricsView(ctx);
    } catch (err) {
      // The player may not exist yet at start-up; the view starts when a track begins.
      ctx.log("lyrics view could not read the player yet", err);
    }
    ctx.registerSidebarItem({ id: "lyrics", label: "Lyrics", icon: <LyricsIcon />, render: () => <LyricsPage /> });
    ctx.registerCommand({
      id: "lyrics.karaoke",
      title: "Show lyrics in karaoke mode",
      keywords: ["lyrics", "karaoke", "sing"],
      run: () => {
        useNav.getState().navigate({ kind: "plugin", itemId: "lyrics" });
        useLyricsView.getState().setKaraoke(true);
      },
    });
  },
  deactivate() {
    stopLyricsView();
  },
};

export default plugin;
