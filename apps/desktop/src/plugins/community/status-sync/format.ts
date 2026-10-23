import { SLACK_EMOJI_RE, SLACK_STATUS_MAX } from "../../../../electron/slack";
import { primaryArtist, type Track } from "@/shared/types";

export interface StatusSettings {
  /** Opt in. Nothing is sent to Slack until this is on. */
  enabled: boolean;
  /** Placeholders: {title}, {artist}, {album}. */
  template: string;
  emoji: string;
  clearOnPause: boolean;
  /** Share only that you are listening, not what. */
  hideTitle: boolean;
}

export const DEFAULT_STATUS_SETTINGS: StatusSettings = {
  enabled: false,
  template: "{title} - {artist}",
  emoji: ":headphones:",
  clearOnPause: true,
  hideTitle: false,
};

export const PRIVATE_TEXT = "Listening to music";
/** A forgotten pause should not leave a status up for long. */
const PAUSED_STATUS_SECONDS = 10 * 60;
/** Slack clears the status this long after the song should have ended, even if we crash. */
const GRACE_SECONDS = 60;

/** Fill the template and cut it to Slack's limit. */
export function formatStatusText(template: string, track: Track, hideTitle: boolean): string {
  if (hideTitle) return PRIVATE_TEXT;
  const artist = track.artists.length > 0 ? primaryArtist(track) : "";
  const text = (template.trim() || DEFAULT_STATUS_SETTINGS.template)
    .replace(/\{title\}/gi, track.title)
    .replace(/\{artist\}/gi, artist)
    .replace(/\{album\}/gi, track.album ?? "")
    .replace(/\s+/g, " ")
    // Tidy separators left dangling when a field was empty, e.g. "Song - ".
    .replace(/\s*[-\u2013\u2014\u00b7|]\s*$/, "")
    .replace(/^\s*[-\u2013\u2014\u00b7|]\s*/, "")
    .trim();
  const clean = text || track.title;
  return clean.length > SLACK_STATUS_MAX ? `${clean.slice(0, SLACK_STATUS_MAX - 1).trimEnd()}\u2026` : clean;
}

export function isValidEmoji(value: string): boolean {
  return SLACK_EMOJI_RE.test(value);
}

export type StatusPlan = { action: "set"; text: string; emoji: string; expiration: number } | { action: "clear" };

export interface PlaybackNow {
  isPlaying: boolean;
  position: number;
  duration: number;
}

/** What Slack should show right now. `nowMs` is the current time in milliseconds. */
export function planStatus(track: Track | null, playback: PlaybackNow, settings: StatusSettings, nowMs: number): StatusPlan {
  if (!settings.enabled || !track) return { action: "clear" };
  if (!playback.isPlaying && settings.clearOnPause) return { action: "clear" };
  const emoji = isValidEmoji(settings.emoji) ? settings.emoji : DEFAULT_STATUS_SETTINGS.emoji;
  const duration = playback.duration || track.durationSec || 0;
  const remaining = playback.isPlaying
    ? duration > playback.position
      ? duration - playback.position
      : 10 * 60
    : PAUSED_STATUS_SECONDS;
  const seconds = Math.min(remaining + GRACE_SECONDS, 23 * 3600);
  return {
    action: "set",
    text: formatStatusText(settings.template, track, settings.hideTitle),
    emoji,
    expiration: Math.floor(nowMs / 1000 + seconds),
  };
}

/** Whether two plans would leave Slack looking the same (so no call is needed). */
export function samePlan(a: StatusPlan | null, b: StatusPlan): boolean {
  if (!a) return false;
  if (a.action === "clear" || b.action === "clear") return a.action === b.action;
  // The expiry always moves; only text and emoji decide what people see.
  return a.text === b.text && a.emoji === b.emoji;
}