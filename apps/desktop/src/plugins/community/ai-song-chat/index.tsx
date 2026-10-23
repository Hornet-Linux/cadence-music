import type { Plugin } from "../../types";
import { useNav } from "@/app/navStore";
import { InfoIcon } from "@/ui/icons";
import { ChatPage } from "./ChatPage";
import { useSongChat } from "./store";

const PAGE_ID = "ai-song-chat";

/** A chat about the song that is playing, using the same AI provider as the DJ. */
const plugin: Plugin = {
  manifest: {
    id: "cadence.ai-song-chat",
    name: "Ask about this song",
    version: "1.0.0",
    description: "Chat with your AI about the song that is playing: its story, meaning, and similar music.",
    author: "Cadence",
    capabilities: ["ui.sidebar", "track.actions", "commands", "player.read"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSidebarItem({ id: PAGE_ID, label: "Ask AI", icon: <InfoIcon size={22} />, render: () => <ChatPage /> });
    ctx.registerTrackAction({
      id: "ask-ai",
      label: "Ask AI about this song",
      run: (track) => {
        useSongChat.getState().pin(track);
        useNav.getState().navigate({ kind: "plugin", itemId: PAGE_ID });
      },
    });
    ctx.registerCommand({
      id: "ask-ai",
      title: "Ask AI about the current song",
      keywords: ["ai", "chat", "song", "about"],
      run: () => {
        useSongChat.getState().pin(null);
        useNav.getState().navigate({ kind: "plugin", itemId: PAGE_ID });
      },
    });
  },
};

export default plugin;
