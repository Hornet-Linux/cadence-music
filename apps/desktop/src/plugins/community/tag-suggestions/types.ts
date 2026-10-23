export type TagField = "title" | "artist" | "album" | "albumArtist" | "trackNo";
export type Status = "pending" | "accepted" | "rejected" | "reverted";

export interface Suggestion {
  id: number;
  trackId: string;
  relPath: string;
  trackTitle: string;
  trackArtist: string | null;
  field: TagField;
  oldValue: string | null;
  newValue: string;
  rule: string;
  reason: string;
  status: Status;
  createdAt: number;
  decidedAt: number | null;
}

export interface SuggestionList {
  items: Suggestion[];
  total: number;
  byStatus: Record<string, number>;
  pendingByRule: Record<string, number>;
  overlays: number;
}

export const FIELD_NAMES: Record<TagField, string> = {
  title: "Title",
  artist: "Artist",
  album: "Album",
  albumArtist: "Album artist",
  trackNo: "Track number",
};

export const RULE_NAMES: Record<string, string> = {
  casing: "Capitalisation",
  feat: "feat. wording",
  spacing: "Extra spaces",
  "album-artist": "Album artist",
  "track-number": "Track number from file name",
  "title-from-filename": "Title from file name",
  "from-folders": "From Artist/Album folders",
};

export const ruleName = (rule: string) => RULE_NAMES[rule] ?? rule;
