import type { Plugin } from "../../types";
import { ListIcon } from "@/ui/icons";
import { PlaylistPage } from "./PlaylistPage";

/** Describe a playlist in a sentence; the AI names songs and only ones found in your sources are kept. */
const plugin: Plugin = {
  manifest: {
    id: "cadence.ai-playlist",
    name: "AI playlist builder",
    version: "1.0.0",
    description: "Describe a playlist in words and get a queue or saved playlist, checked against your own music.",
    author: "Cadence",
    capabilities: ["ui.sidebar", "player.queue"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSidebarItem({ id: "ai-playlist", label: "AI playlist", icon: <ListIcon size={22} />, render: () => <PlaylistPage /> });
  },
};

export default plugin;
