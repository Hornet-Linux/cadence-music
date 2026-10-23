import { primaryArtist, type Track } from "@/shared/types";
import type { PlaybackEvent } from "../../types";

// Mood radio logic that needs no UI or network: the moods, and the feedback
// loop that learns from what the listener skips and finishes.

export type MoodId = "focus" | "workout" | "sleep" | "party" | "commute";

export interface Mood {
  id: MoodId;
  name: string;
  blurb: string;
  /** Sent to the DJ as what the listener asked for. */
  prompt: string;
}

export const MOODS: Mood[] = [
  {
    id: "focus",
    name: "Focus",
    blurb: "Steady and unobtrusive, for deep work.",
    prompt: "focus music for deep work: steady, mostly instrumental or lyric-light, no sudden energy spikes or jarring songs",
  },
  {
    id: "workout",
    name: "Workout",
    blurb: "Driving tempo that keeps you moving.",
    prompt: "high-energy workout music: driving tempo around 120 to 170 BPM, motivating, keep the energy up throughout",
  },
  {
    id: "sleep",
    name: "Sleep",
    blurb: "Soft and slow, to wind down.",
    prompt: "music to fall asleep to: very calm, slow and soft, ambient or gentle acoustic, nothing loud or sudden, no abrupt endings",
  },
  {
    id: "party",
    name: "Party",
    blurb: "Crowd-pleasers you can dance to.",
    prompt: "party music: danceable crowd-pleasers, upbeat and singalong, songs most people know",
  },
  {
    id: "commute",
    name: "Commute",
    blurb: "Easy and upbeat for the trip.",
    prompt: "easy commute music: upbeat but relaxed, familiar and comfortable, good for a drive or a train ride",
  },
];

export const MAX_CUSTOM_MOOD = 120;

/** The mood text for the DJ: a preset's prompt, or the listener's own words. */
export function moodPrompt(mood: MoodId | "custom", custom: string): string {
  if (mood === "custom") return custom.replace(/\s+/g, " ").trim().slice(0, MAX_CUSTOM_MOOD);
  return MOODS.find((m) => m.id === mood)?.prompt ?? "";
}

// ---- listening feedback -------------------------------------------------------------

/** Skipped within this many seconds (and before halfway) counts as "not for me". */
export const SKIP_SECONDS = 45;
/** Played at least this much counts as finished. */
export const FINISH_RATIO = 0.8;
/** This many skips in a row means the direction is wrong. */
export const SKIP_STREAK = 3;
/** Don't change direction more often than this. */
export const SWITCH_COOLDOWN_MS = 90_000;

export type Outcome = "skipped" | "finished" | "partial";

export interface Reaction {
  track: Track;
  outcome: Outcome;
}

/** Decide how a listen went from how far it got. */
export function classify(position: number, duration: number, ended: boolean): Outcome {
  if (ended) return "finished";
  if (duration > 0 && position / duration >= FINISH_RATIO) return "finished";
  const half = duration > 0 ? position / duration < 0.5 : true;
  if (position < SKIP_SECONDS && half) return "skipped";
  return "partial";
}

/**
 * Watches playback events and says, for each radio track, whether it was
 * skipped or finished. Only tracks the radio queued count.
 */
export class ListenTracker {
  private cur: { track: Track; position: number; duration: number; ended: boolean } | null = null;
  readonly reactions: Reaction[] = [];
  /** Reactions before this index are not counted in the skip streak (the radio changed direction). */
  private streakFrom = 0;

  constructor(
    private readonly isRadioTrack: (id: string) => boolean,
    private readonly onReaction: (r: Reaction) => void = () => undefined,
  ) {}

  private finish() {
    const c = this.cur;
    this.cur = null;
    if (!c || !this.isRadioTrack(c.track.id)) return;
    const outcome = classify(c.position, c.duration, c.ended);
    const reaction = { track: c.track, outcome };
    this.reactions.push(reaction);
    if (this.reactions.length > 60) {
      this.reactions.shift();
      this.streakFrom = Math.max(0, this.streakFrom - 1);
    }
    this.onReaction(reaction);
  }

  /** Feed every playback event in. */
  handle(e: PlaybackEvent): void {
    if (e.kind === "track") {
      if (this.cur && this.cur.track.id !== e.track?.id) this.finish();
      if (e.track && !this.cur) this.cur = { track: e.track, position: 0, duration: e.track.durationSec ?? 0, ended: false };
      return;
    }
    if (!this.cur || e.track?.id !== this.cur.track.id) return;
    if (e.kind === "ended") {
      this.cur.ended = true;
      this.cur.position = e.duration;
      this.cur.duration = e.duration;
      return;
    }
    if (e.kind === "progress" || e.kind === "seek") {
      // A seek forward is not a listen: only count time moving on its own.
      if (e.kind === "progress") this.cur.position = Math.max(this.cur.position, e.position);
      if (e.duration > 0) this.cur.duration = e.duration;
    }
  }

  /** Close the song that is still playing (when the radio stops). */
  flush(): void {
    this.finish();
  }

  /** Skips since the last song that was finished or only partly heard. */
  skipStreak(): number {
    let n = 0;
    for (let i = this.reactions.length - 1; i >= this.streakFrom; i--) {
      const o = this.reactions[i].outcome;
      if (o === "skipped") n++;
      else break;
    }
    return n;
  }

  /** Start counting skips afresh (after a change of direction). */
  resetStreak(): void {
    this.streakFrom = this.reactions.length;
  }

  counts(): { skipped: number; finished: number } {
    return {
      skipped: this.reactions.filter((r) => r.outcome === "skipped").length,
      finished: this.reactions.filter((r) => r.outcome === "finished").length,
    };
  }
}

const line = (t: Track) => `${primaryArtist(t)} – ${t.title}`;

/**
 * What the listener did, as short lines for the DJ prompt: the most recent
 * skips and finishes, so the next set moves toward what they kept.
 */
export function feedbackNotes(reactions: Reaction[], maxSkips = 5, maxFinished = 3): string[] {
  const skipped = reactions.filter((r) => r.outcome === "skipped").slice(-maxSkips);
  const finished = reactions.filter((r) => r.outcome === "finished").slice(-maxFinished);
  return [
    ...skipped.map((r) => `Skipped quickly (play less like this): ${line(r.track)}`),
    ...finished.map((r) => `Listened all the way through (play more like this): ${line(r.track)}`),
  ];
}

/** Should the radio change direction now? */
export function shouldSwitchUp(streak: number, lastSwitchAt: number, now: number): boolean {
  return streak >= SKIP_STREAK && now - lastSwitchAt >= SWITCH_COOLDOWN_MS;
}

/** Radio tracks left after the current one. */
export const upcoming = (queueLength: number, index: number) => Math.max(0, queueLength - 1 - index);
