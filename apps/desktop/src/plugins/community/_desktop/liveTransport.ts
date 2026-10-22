import { useCollection } from "@/features/collection/collectionStore";
import type { PlayerApi } from "../../types";
import { transportActions } from "./transport";

/** The transport commands wired to the real collection (likes). */
export function liveTransport(player: PlayerApi) {
  return transportActions({
    player,
    toggleLike: (track) => useCollection.getState().toggleLike(track),
    isLiked: (id) => useCollection.getState().likes.some((l) => l.track.id === id),
  });
}