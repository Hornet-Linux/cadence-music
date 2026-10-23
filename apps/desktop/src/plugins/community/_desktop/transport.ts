import type { Track } from "@/shared/types";
import type { PlayerApi } from "../../types";

/** What the transport commands need from the app. Injected so they can be tested. */
export interface TransportDeps {
  player: PlayerApi;
  /** Toggle a track's liked state. */
  toggleLike: (track: Track) => void;
  isLiked: (trackId: string) => boolean;
}

export interface TransportAction {
  title: string;
  /** Throws a short, readable Error for bad arguments. */
  run: (args: Record<string, unknown>) => void | Promise<void> | unknown;
}

const VOLUME_STEP = 0.05;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Accepts 0..1 or a percentage (anything above 1 is read as 0..100). */
export function parseVolume(value: unknown): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new Error("value must be a number between 0 and 1 (or 0 to 100)");
  return clamp01(n > 1 ? n / 100 : n);
}

/**
 * The standard playback commands. Keys are the names scripts and remotes use
 * (`/v1/command/next`), and the media-keys plugin registers the same set with the
 * command registry under `cadence.media-keys.<name>`.
 */
export function transportActions(deps: TransportDeps): Record<string, TransportAction> {
  const state = () => deps.player.getState();
  const current = () => {
    const track = state().current;
    if (!track) throw new Error("nothing_playing");
    return track;
  };
  return {
    play: { title: "Play", run: () => void (!state().isPlaying && state().current && deps.player.toggle()) },
    pause: { title: "Pause", run: () => void (state().isPlaying && deps.player.toggle()) },
    "play-pause": { title: "Play or pause", run: () => void (state().current && deps.player.toggle()) },
    next: { title: "Next track", run: () => deps.player.next() },
    previous: { title: "Previous track", run: () => deps.player.previous() },
    "volume-up": { title: "Volume up", run: () => deps.player.setVolume(clamp01(state().volume + VOLUME_STEP)) },
    "volume-down": { title: "Volume down", run: () => deps.player.setVolume(clamp01(state().volume - VOLUME_STEP)) },
    volume: { title: "Set volume", run: (args) => deps.player.setVolume(parseVolume(args.value)) },
    seek: {
      title: "Seek",
      run: (args) => {
        const s = typeof args.seconds === "number" ? args.seconds : Number(args.seconds);
        if (!Number.isFinite(s) || s < 0) throw new Error("seconds must be zero or more");
        deps.player.seek(s);
      },
    },
    like: { title: "Like this song", run: () => void (!deps.isLiked(current().id) && deps.toggleLike(current())) },
    unlike: { title: "Unlike this song", run: () => void (deps.isLiked(current().id) && deps.toggleLike(current())) },
    "toggle-like": { title: "Like or unlike this song", run: () => deps.toggleLike(current()) },
  };
}