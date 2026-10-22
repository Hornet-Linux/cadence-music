import { useMemo } from "react";
import type { Plugin } from "../../types";
import { useServer } from "../../builtins/server/serverStore";
import { BookIcon } from "../_sourcekit/icons";
import { AudiobookSettings } from "./AudiobookSettings";
import { AudiobooksPage } from "./AudiobooksPage";
import { activeBook, bookIdOf, bookToTrack, resolveBook, useAudiobooks } from "./audiobookStore";

let watchingServer = false;
function followServerAccount() {
  if (watchingServer) return;
  watchingServer = true;
  useServer.subscribe((state, prev) => {
    if (state.user?.username === prev.user?.username) return;
    if (state.user) void useAudiobooks.getState().refreshStatus();
    else useAudiobooks.getState().reset();
  });
}

/** Your Audiobookshelf library, with your own account: progress is saved back as you listen. */
const audiobooksPlugin: Plugin = {
  manifest: {
    id: "cadence.audiobooks",
    name: "Audiobooks (Audiobookshelf)",
    version: "1.0.0",
    description:
      "Listen to your Audiobookshelf library with your own account. Chapters, bookmarks, a sleep timer that fades out, and your place saved back to Audiobookshelf so every app agrees where you are.",
    author: "Cadence",
    capabilities: ["source.audio", "source.library", "ui.sidebar", "ui.settings", "commands", "player.read", "player.control", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    followServerAccount();
    if (useServer.getState().user) void useAudiobooks.getState().refreshStatus();

    ctx.registerSidebarItem({ id: "audiobooks", label: "Audiobooks", icon: <BookIcon />, render: () => <AudiobooksPage /> });
    ctx.registerSettingsPanel({
      id: "audiobooks",
      title: "Audiobooks",
      description: "Sign in to Audiobookshelf.",
      icon: <BookIcon size={19} />,
      keywords: ["audiobookshelf", "books", "sign in", "listening"],
      render: () => <AudiobookSettings />,
    });
    ctx.registerAudioSource({
      id: "audiobooks",
      label: "Audiobookshelf",
      async resolve(track) {
        const id = bookIdOf(track);
        if (!id || !useServer.getState().token) return null;
        return resolveBook(id);
      },
    });
    ctx.registerLibrarySource({
      id: "audiobooks",
      label: "Audiobooks in progress",
      useTracks() {
        const books = useAudiobooks((s) => s.continueBooks);
        return useMemo(() => books.map(bookToTrack), [books]);
      },
    });
    ctx.registerCommand({
      id: "audiobooks.sleep30",
      title: "Audiobooks: sleep in 30 minutes",
      keywords: ["sleep", "timer"],
      run: () => useAudiobooks.getState().startSleep({ minutes: 30 }, ctx.player.getState().position),
    });
    ctx.registerCommand({
      id: "audiobooks.back",
      title: "Audiobooks: back 30 seconds",
      run: () => {
        if (activeBook()) ctx.player.seek(Math.max(0, ctx.player.getState().position - 30));
      },
    });
  },
};

export default audiobooksPlugin;