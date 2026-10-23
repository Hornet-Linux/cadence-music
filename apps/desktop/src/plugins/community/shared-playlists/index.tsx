import type { Plugin } from "@/plugins/types";
import { UsersIcon } from "../_social/ui";
import { SHARED_ITEM_ID, SharedPlaylistsPage } from "./SharedPlaylistsPage";

/**
 * Collaborative playlists between accounts on the same server: everyone in a playlist adds songs and
 * votes, and the list orders itself by votes. Needs the server plugin cadence.shared-playlists.
 */
const sharedPlaylists: Plugin = {
  manifest: {
    id: "cadence.shared-playlists",
    name: "Shared playlists",
    version: "1.0.0",
    description: "Build playlists together with other people on your server, with voting.",
    author: "Cadence",
    capabilities: ["ui.sidebar", "player.queue", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSidebarItem({ id: SHARED_ITEM_ID, label: "Shared playlists", icon: <UsersIcon />, render: () => <SharedPlaylistsPage /> });
  },
};

export default sharedPlaylists;