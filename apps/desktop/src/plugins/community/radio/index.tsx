import { useMemo } from "react";
import type { Plugin } from "../../types";
import type { Track } from "@/shared/types";
import { useServer } from "../../builtins/server/serverStore";
import { createMediaHandle } from "../_sourcekit/handle";
import { RadioIcon } from "../_sourcekit/icons";
import { RadioPage } from "./RadioPage";
import { announce, stationIdOf, stationToTrack, streamFor, useRadio, watchNowPlaying } from "./radioStore";

let watchingServer = false;
/** Favourites follow the Cadence account: load on sign-in, forget on sign-out. */
function followServerAccount() {
  if (watchingServer) return;
  watchingServer = true;
  useServer.subscribe((state, prev) => {
    if (state.user?.username === prev.user?.username) return;
    if (state.user) void useRadio.getState().loadFavourites();
    else useRadio.getState().reset();
  });
}

let stopWatching: (() => void) | null = null;

/** Internet radio from the Radio Browser directory, played through your Cadence server. */
const radioPlugin: Plugin = {
  manifest: {
    id: "cadence.radio",
    name: "Internet radio",
    version: "1.0.0",
    description:
      "Search thousands of live radio stations by name, genre, country or language, keep favourites that follow you between devices, and see what's playing. Streams go through your server, so plain-HTTP stations work too.",
    author: "Cadence",
    capabilities: ["source.audio", "source.library", "ui.sidebar", "player.read", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    followServerAccount();
    if (useServer.getState().user) void useRadio.getState().loadFavourites();

    ctx.registerSidebarItem({ id: "radio", label: "Radio", icon: <RadioIcon />, render: () => <RadioPage /> });

    ctx.registerAudioSource({
      id: "radio",
      label: "Internet radio",
      async resolve(track: Track) {
        const id = stationIdOf(track);
        if (!id || !useServer.getState().token) return null;
        const { url, hls } = await streamFor(id);
        // Ordinary streams play in the shared player; HLS needs its own element (and hls.js where the browser lacks it).
        if (!hls) return url;
        return createMediaHandle({ segments: [{ url, startOffset: 0, duration: 0 }], hls: true, totalDuration: 0 });
      },
    });

    ctx.registerLibrarySource({
      id: "radio",
      label: "Radio favourites",
      useTracks() {
        const favourites = useRadio((s) => s.favourites);
        return useMemo(() => favourites.map(stationToTrack), [favourites]);
      },
    });

    // Follow the station's "now playing" text while a station is the current track.
    ctx.onNowPlaying((track) => {
      stopWatching?.();
      stopWatching = null;
      const id = track ? stationIdOf(track) : null;
      useRadio.getState().setNowPlaying(id ? { stationId: id, title: null } : null);
      if (!track || !id) return;
      stopWatching = watchNowPlaying(id, (title) => {
        useRadio.getState().setNowPlaying({ stationId: id, title });
        announce(track, title);
      });
    });
  },
  deactivate() {
    stopWatching?.();
    stopWatching = null;
  },
};

export default radioPlugin;