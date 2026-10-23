import { useNav } from "@/app/navStore";
import type { Plugin } from "@/plugins/types";
import { CardIcon } from "../_social/ui";
import { SHARE_ITEM_ID, SharePage, useShareCard } from "./SharePage";

/** Turn the current track (cover, title, artist) into a clean image to download, copy or share. */
const shareCard: Plugin = {
  manifest: {
    id: "cadence.share-card",
    name: "Share card",
    version: "1.0.0",
    description: "Draws a clean image card of the current track that you can download, copy or share.",
    author: "Cadence",
    capabilities: ["ui.sidebar", "track.actions", "commands", "player.read"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    const open = (track: Parameters<ReturnType<typeof useShareCard.getState>["set"]>[0]) => {
      useShareCard.getState().set(track);
      useNav.getState().navigate({ kind: "plugin", itemId: SHARE_ITEM_ID });
    };
    ctx.registerSidebarItem({ id: SHARE_ITEM_ID, label: "Share card", icon: <CardIcon />, render: () => <SharePage /> });
    ctx.registerTrackAction({ id: "share-card", label: "Share card...", run: (track) => open(track) });
    ctx.registerCommand({
      id: "share-card.current",
      title: "Make a share card for the current track",
      keywords: ["share", "image", "cover"],
      run: () => open(ctx.player.getState().current),
    });
  },
};

export default shareCard;