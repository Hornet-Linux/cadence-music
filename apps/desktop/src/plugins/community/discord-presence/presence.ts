import type { PresenceActivity } from "../../../../electron/presenceShared";
import { isPublicImageUrl } from "../../../../electron/presenceShared";
import { primaryArtist, type Track } from "@/shared/types";

export interface PresenceSettings {
  /** Discord application ID (a 17 to 20 digit number). */
  applicationId: string;
  /** Show the cover art, when it has a public https address. */
  showArtwork: boolean;
  showAlbum: boolean;
  /** Remove the presence while paused instead of showing "Paused". */
  hideWhenPaused: boolean;
  /** Share nothing at all. A quick privacy switch. */
  private: boolean;
}

export const DEFAULT_PRESENCE_SETTINGS: PresenceSettings = {
  applicationId: "",
  showArtwork: true,
  showAlbum: true,
  hideWhenPaused: false,
  private: false,
};

export interface PlaybackSnapshot {
  isPlaying: boolean;
  /** Seconds. */
  position: number;
  /** Seconds, 0 when unknown. */
  duration: number;
}

/** What Discord should show right now, or null to show nothing. */
export function buildPresence(
  track: Track | null,
  playback: PlaybackSnapshot,
  settings: PresenceSettings,
  now: number,
): PresenceActivity | null {
  if (!track || settings.private) return null;
  if (!playback.isPlaying && settings.hideWhenPaused) return null;

  const artist = track.artists.length > 0 ? primaryArtist(track) : "";
  const activity: PresenceActivity = { details: track.title };
  if (playback.isPlaying) {
    activity.state = artist ? `by ${artist}` : undefined;
    const position = Math.max(0, playback.position);
    activity.startMs = Math.round(now - position * 1000);
    const duration = playback.duration || track.durationSec || 0;
    if (duration > position) activity.endMs = Math.round(now + (duration - position) * 1000);
  } else {
    // Paused: no running clock.
    activity.state = artist ? `Paused \u00b7 ${artist}` : "Paused";
  }
  if (settings.showAlbum && track.album) activity.largeText = track.album;
  if (settings.showArtwork && isPublicImageUrl(track.artwork)) {
    activity.largeImage = track.artwork;
    activity.largeText ??= track.title;
  }
  return activity;
}

/** True for a plausible Discord application ID. */
export function isApplicationId(value: string): boolean {
  return /^\d{17,20}$/.test(value.trim());
}