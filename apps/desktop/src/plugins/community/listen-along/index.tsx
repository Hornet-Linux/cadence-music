import { useNav } from "@/app/navStore";
import type { Plugin } from "@/plugins/types";
import { UsersIcon } from "../_social/ui";
import { LISTEN_ITEM_ID, ListenAlongPage } from "./ListenAlongPage";
import { attachPlayer, onHostPlayback, stopAll, takeInviteFromLocation, useListenAlong } from "./store";

/**
 * Listening rooms: a host plays music and everyone in the room follows the host's song and
 * position. The server relays the host's state (server-sent events) and guests correct drift
 * with small speed changes or a jump. Needs the "Listen along" server plugin (community plugin
 * cadence.listen-along, enabled by the server admin).
 */
const listenAlong: Plugin = {
  manifest: {
    id: "cadence.listen-along",
    name: "Listen along",
    version: "1.0.0",
    description: "Start a listening room, or join a friend's and follow their song and position.",
    author: "Cadence",
    capabilities: ["ui.sidebar", "player.read", "player.control", "player.queue", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    attachPlayer(ctx.player);
    ctx.onPlayback((event) => onHostPlayback(event));
    ctx.registerSidebarItem({ id: LISTEN_ITEM_ID, label: "Listen along", icon: <UsersIcon />, render: () => <ListenAlongPage /> });

    // An invitation link (?room=CODE) takes you to the join form with the code filled in.
    const invite = takeInviteFromLocation();
    if (invite) {
      useListenAlong.setState({ invite });
      useNav.getState().navigate({ kind: "plugin", itemId: LISTEN_ITEM_ID });
    }
  },
  deactivate() {
    stopAll();
  },
};

export default listenAlong;