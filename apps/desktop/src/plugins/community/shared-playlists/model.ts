import type { Track } from "@/shared/types";

/** What the shared-playlists server plugin returns. */
export interface SharedItem {
  id: string;
  track: Track;
  addedBy: { id: number; name: string } | null;
  addedAt: number;
  score: number;
  myVote: -1 | 0 | 1;
}

export interface SharedDetail {
  id: string;
  name: string;
  ownerId: number;
  isOwner: boolean;
  joinCode?: string;
  members: { id: number; name: string }[];
  items: SharedItem[];
  createdAt: number;
  updatedAt: number;
}

export interface SharedSummary {
  id: string;
  name: string;
  ownerName: string;
  isOwner: boolean;
  memberCount: number;
  trackCount: number;
  updatedAt: number;
  artwork: string[];
}

/** Same ordering as the server: highest score first, ties by when added. */
export function sortItems(items: SharedItem[]): SharedItem[] {
  return [...items].sort((a, b) => b.score - a.score || a.addedAt - b.addedAt || a.id.localeCompare(b.id));
}

/** Show a vote straight away (before the server answers): change my vote, the score and the order. */
export function withVote(detail: SharedDetail, itemId: string, value: -1 | 0 | 1): SharedDetail {
  const items = detail.items.map((item) => (item.id === itemId ? { ...item, score: item.score - item.myVote + value, myVote: value } : item));
  return { ...detail, items: sortItems(items) };
}

/** What happens when the same arrow is pressed again: the vote is taken back. */
export function nextVote(current: -1 | 0 | 1, pressed: -1 | 1): -1 | 0 | 1 {
  return current === pressed ? 0 : pressed;
}

export function canRemove(detail: SharedDetail, item: SharedItem, myUserId: number | null): boolean {
  return detail.isOwner || (myUserId !== null && item.addedBy?.id === myUserId);
}

/** Tracks in play order, ready for the player. */
export const playOrder = (detail: SharedDetail): Track[] => detail.items.map((i) => i.track);