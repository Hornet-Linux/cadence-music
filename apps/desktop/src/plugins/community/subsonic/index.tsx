import type { Plugin } from "@/plugins/types";
import { DiscIcon } from "@/ui/icons";
import { useServer } from "../../builtins/server/serverStore";
import { createPlaybackReporter, watchPlayer } from "../sourcesCommon/reporter";
import { SubsonicPage } from "./SubsonicPage";
import { SubsonicSettings } from "./SubsonicSettings";
import { subsonicTrackId, useSubsonic } from "./subsonicStore";

let watching = false;

/** Follow the Cadence account (look the sign-in up on login, forget it on logout) and report plays. */
function followAccountAndPlayback() {
  if (watching) return;
  watching = true;
  useServer.subscribe((state, prev) => {
    if (state.user?.username === prev.user?.username) return;
    if (state.user) void useSubsonic.getState().refresh();
    else useSubsonic.getState().reset();
  });
  watchPlayer(
    createPlaybackReporter(subsonicTrackId, (event, id, position, duration) => {
      // Signed out of Subsonic: nothing to tell it.
      if (useSubsonic.getState().status?.connected) void useSubsonic.getState().report(event, id, position, duration);
    }),
  );
}

/** Subsonic-compatible servers (Navidrome, Airsonic-Advanced, Gonic) streamed through the Cadence server. */
const subsonicPlugin: Plugin = {
  manifest: {
    id: "cadence.subsonic",
    name: "Subsonic",
    version: "1.0.0",
    description:
      "Browse and play a Navidrome, Airsonic-Advanced or Gonic library through your Cadence server, with stars, playlists and scrobbling. The server owner also needs to turn on the Subsonic server plugin.",
    author: "Cadence",
    capabilities: ["source.audio", "source.library", "ui.sidebar", "ui.settings", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    followAccountAndPlayback();
    if (useServer.getState().user) void useSubsonic.getState().refresh();

    ctx.registerSettingsPanel({
      id: "subsonic",
      title: "Subsonic",
      description: "Navidrome, Airsonic or Gonic, played through your server.",
      icon: <DiscIcon size={19} />,
      keywords: ["navidrome", "airsonic", "gonic", "account", "sign in", "login", "media server", "scrobble"],
      render: () => <SubsonicSettings />,
    });
    ctx.registerSidebarItem({ id: "subsonic", label: "Subsonic", icon: <DiscIcon />, render: () => <SubsonicPage /> });
    ctx.registerLibrarySource({
      id: "subsonic",
      label: "Subsonic",
      useTracks: () => useSubsonic((s) => s.tracks),
    });
    ctx.registerAudioSource({
      id: "subsonic",
      label: "Subsonic",
      async resolve(track) {
        const id = subsonicTrackId(track);
        if (!id || !useServer.getState().token) return null;
        return useSubsonic.getState().streamUrl(id);
      },
    });
  },
};

export default subsonicPlugin;