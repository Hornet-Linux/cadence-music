import type { Plugin } from "@/plugins/types";
import { NoteIcon } from "@/ui/icons";
import { useServer } from "../../builtins/server/serverStore";
import { createPlaybackReporter, watchPlayer } from "../sourcesCommon/reporter";
import { PlexPage } from "./PlexPage";
import { PlexSettings } from "./PlexSettings";
import { plexTrackId, usePlex } from "./plexStore";

let watching = false;

/** Follow the Cadence account (look the link up on login, forget it on logout) and report plays. */
function followAccountAndPlayback() {
  if (watching) return;
  watching = true;
  useServer.subscribe((state, prev) => {
    if (state.user?.username === prev.user?.username) return;
    if (state.user) void usePlex.getState().refresh();
    else usePlex.getState().reset();
  });
  watchPlayer(
    createPlaybackReporter(plexTrackId, (event, id, position, duration) => {
      const status = usePlex.getState().status;
      if (status?.connected) void usePlex.getState().report(event, id, position, duration);
    }),
  );
}

/** Your Plex music, linked with a plex.tv code and streamed through the Cadence server. */
const plexPlugin: Plugin = {
  manifest: {
    id: "cadence.plex",
    name: "Plex",
    version: "1.0.0",
    description:
      "Link your Plex account with a code, pick a music library, then browse, search and play it through your Cadence server, with favourites, playlists and play counts. The server owner also needs to turn on the Plex server plugin.",
    author: "Cadence",
    capabilities: ["source.audio", "source.library", "ui.sidebar", "ui.settings", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    followAccountAndPlayback();
    if (useServer.getState().user) void usePlex.getState().refresh();

    ctx.registerSettingsPanel({
      id: "plex",
      title: "Plex",
      description: "Your Plex music, played through your server.",
      icon: <NoteIcon size={19} />,
      keywords: ["account", "link", "sign in", "plex.tv", "media server", "library"],
      render: () => <PlexSettings />,
    });
    ctx.registerSidebarItem({ id: "plex", label: "Plex", icon: <NoteIcon />, render: () => <PlexPage /> });
    ctx.registerLibrarySource({
      id: "plex",
      label: "Plex",
      useTracks: () => usePlex((s) => s.tracks),
    });
    ctx.registerAudioSource({
      id: "plex",
      label: "Plex",
      async resolve(track) {
        const id = plexTrackId(track);
        if (!id || !useServer.getState().token) return null;
        return usePlex.getState().streamUrl(id);
      },
    });
  },
};

export default plexPlugin;