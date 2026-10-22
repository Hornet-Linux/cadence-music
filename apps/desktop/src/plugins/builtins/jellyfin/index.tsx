import type { Plugin } from "../../types";
import { DiscIcon } from "@/ui/icons";
import { useServer } from "../server/serverStore";
import { JellyfinPage } from "./JellyfinPage";
import { JellyfinSettings } from "./JellyfinSettings";
import { jellyfinItemId, useJellyfin } from "./jellyfinStore";
import { startPlaybackReporting } from "./playbackReporter";

let watchingServer = false;

/** Jellyfin follows the Cadence account: look it up on sign-in, forget it on sign-out. */
function followServerAccount() {
  if (watchingServer) return;
  watchingServer = true;
  useServer.subscribe((state, prev) => {
    if (state.user?.username === prev.user?.username) return;
    if (state.user) void useJellyfin.getState().refresh();
    else useJellyfin.getState().reset();
  });
}

/** Your Jellyfin music, streamed through the Cadence server (it holds the Jellyfin sign-in). */
export const jellyfinPlugin: Plugin = {
  manifest: {
    id: "core.jellyfin",
    name: "Jellyfin",
    version: "1.0.0",
    description:
      "Browse and play your Jellyfin music through your Cadence server, with favourites, playlists, play counts and AI DJ picks from your Jellyfin library.",
    author: "Cadence",
    capabilities: ["source.audio", "ui.sidebar", "ui.settings", "network.outbound"],
    apiRange: "^1.0.0",
    builtin: true,
  },
  activate(ctx) {
    followServerAccount();
    startPlaybackReporting();
    if (useServer.getState().user) void useJellyfin.getState().refresh();

    ctx.registerSettingsPanel({
      id: "jellyfin",
      title: "Jellyfin",
      description: "Your Jellyfin music, played through your server.",
      icon: <DiscIcon size={19} />,
      keywords: ["account", "sign in", "login", "media server", "favourites", "playlists"],
      render: () => <JellyfinSettings />,
    });
    ctx.registerSetupStep({
      id: "jellyfin",
      title: "Connect Jellyfin",
      description: "Play the music on your Jellyfin server here. Skip this if you don't use Jellyfin.",
      weight: 30,
      render: () => <JellyfinSettings />,
    });
    ctx.registerSidebarItem({ id: "jellyfin", label: "Jellyfin", icon: <DiscIcon />, render: () => <JellyfinPage /> });
    ctx.registerAudioSource({
      id: "jellyfin",
      label: "Jellyfin",
      async resolve(track) {
        const itemId = jellyfinItemId(track);
        if (!itemId || !useServer.getState().token) return null;
        return useJellyfin.getState().streamUrl(itemId);
      },
    });
  },
};
