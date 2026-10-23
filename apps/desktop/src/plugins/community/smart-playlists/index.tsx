import type { Plugin } from "../../types";
import { SparkleIcon } from "@/ui/icons";
import { SmartPlaylistsPage } from "./SmartPlaylistsPage";
import "./style.css";

/** Rule-based playlists that the server fills and keeps up to date. */
const smartPlaylistsPlugin: Plugin = {
  manifest: {
    id: "cadence.smart-playlists",
    name: "Smart playlists",
    version: "1.0.0",
    description:
      "Build playlists from rules (genre, year, play count, last played, date added, tempo, loudness, favourites). The server keeps them up to date. Needs the matching server plugin to be switched on.",
    author: "Cadence",
    capabilities: ["ui.sidebar", "network.outbound", "player.queue"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSidebarItem({
      id: "smart-playlists",
      label: "Smart playlists",
      icon: <SparkleIcon />,
      render: () => <SmartPlaylistsPage />,
    });
  },
};

export default smartPlaylistsPlugin;
