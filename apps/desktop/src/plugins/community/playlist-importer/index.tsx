import type { Plugin } from "../../types";
import { ListIcon } from "@/ui/icons";
import ImporterPage from "./Importer";
import "./style.css";

const plugin: Plugin = {
  manifest: {
    id: "cadence.playlist-importer",
    name: "Playlist importer",
    version: "1.0.0",
    description:
      "Import playlists from Spotify or from M3U, XSPF, CSV, JSON, Apple Music and Last.fm files. Each track is matched to your library with a score, you review the result and fix mistakes, then the playlist is created.",
    author: "Cadence",
    capabilities: ["ui.sidebar", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSidebarItem({ id: "playlist-importer", label: "Import", icon: <ListIcon />, render: () => <ImporterPage /> });
  },
};

export default plugin;