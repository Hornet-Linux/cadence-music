import type { Driver, DriverControls, DriverHooks } from "../_streaming/embedded";

/**
 * Drives YouTube's official IFrame Player (https://developers.google.com/youtube/iframe_api_reference).
 * The player is created by YouTube's own script inside the visible panel; we only call its
 * documented methods and listen to its documented events. We never hide, restyle or cover it.
 */

const API_URL = "https://www.youtube.com/iframe_api";

export interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setVolume(volume: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  destroy(): void;
}

interface YTPlayerOptions {
  width: string | number;
  height: string | number;
  videoId: string;
  playerVars?: Record<string, string | number>;
  events: {
    onReady?: () => void;
    onStateChange?: (e: { data: number }) => void;
    onError?: (e: { data: number }) => void;
    onAutoplayBlocked?: () => void;
  };
}

export interface YTNamespace {
  Player: new (el: HTMLElement, options: YTPlayerOptions) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let loading: Promise<YTNamespace> | null = null;

/** Load YouTube's IFrame API script once. */
export function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!loading) {
    loading = new Promise<YTNamespace>((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previous?.();
        if (window.YT?.Player) resolve(window.YT);
        else reject(new Error("The YouTube player is unavailable"));
      };
      const script = document.createElement("script");
      script.src = API_URL;
      script.async = true;
      script.onerror = () => {
        loading = null;
        script.remove();
        reject(new Error("Couldn't load the YouTube player. Check your connection."));
      };
      document.head.append(script);
    });
  }
  return loading;
}

const STATE = { ended: 0, playing: 1, paused: 2 } as const;
const POLL_MS = 500;

/** Words for the error codes in YouTube's documentation, and whether the video can never play here. */
export function describeYouTubeError(code: number): { message: string; skip: boolean } {
  switch (code) {
    case 100:
      return { message: "This video was removed or is private. Skipped.", skip: true };
    case 101:
    case 150:
      return { message: "The owner doesn't allow this video to play outside YouTube. Skipped.", skip: true };
    case 153:
      return { message: "YouTube couldn't identify this app (no referrer). Use the web player over http(s) instead of a file:// build.", skip: false };
    case 2:
      return { message: "YouTube rejected the request for this video.", skip: false };
    default:
      return { message: "YouTube's player had a problem with this video.", skip: false };
  }
}

export interface YouTubeDriverDeps {
  load?: () => Promise<YTNamespace>;
  /** The page origin YouTube checks (an http(s) origin only). */
  origin?: string;
}

export function youtubeDriver(videoId: string, deps: YouTubeDriverDeps = {}): Driver {
  const load = deps.load ?? loadYouTubeApi;
  return {
    async setup(body: HTMLElement, hooks: DriverHooks): Promise<DriverControls> {
      const YT = await load();
      const mount = document.createElement("div");
      body.append(mount);
      const origin = deps.origin ?? (/^https?:$/.test(location.protocol) ? location.origin : undefined);

      return await new Promise<DriverControls>((resolve, reject) => {
        let poll: ReturnType<typeof setInterval> | null = null;
        let destroyed = false;
        let player: YTPlayer | null = null;

        const report = () => {
          if (!player || destroyed) return;
          try {
            hooks.progress(player.getCurrentTime(), player.getDuration() || undefined);
          } catch {
            // The player may be mid-teardown.
          }
        };
        const stopPolling = () => {
          if (poll) clearInterval(poll);
          poll = null;
        };
        const timer = setTimeout(() => reject(new Error("The YouTube player took too long to start.")), 20_000);

        const controls: DriverControls = {
          play: () => player?.playVideo(),
          pause: () => player?.pauseVideo(),
          seek: (s) => player?.seekTo(s, true),
          setVolume: (v) => player?.setVolume(Math.round(Math.min(1, Math.max(0, v)) * 100)),
          destroy() {
            destroyed = true;
            stopPolling();
            clearTimeout(timer);
            try {
              player?.destroy();
            } catch {
              // Already gone.
            }
            mount.remove();
          },
        };

        player = new YT.Player(mount, {
          width: "100%",
          height: "100%",
          videoId,
          // The documented parameters only; controls stay on (they are part of the player).
          playerVars: { playsinline: 1, rel: 0, enablejsapi: 1, ...(origin ? { origin } : {}) },
          events: {
            onReady() {
              clearTimeout(timer);
              const d = player?.getDuration();
              hooks.ready({ durationSec: d && d > 0 ? d : undefined });
              resolve(controls);
            },
            onStateChange({ data }) {
              if (destroyed) return;
              if (data === STATE.playing) {
                hooks.state("playing");
                report();
                stopPolling();
                poll = setInterval(report, POLL_MS);
              } else if (data === STATE.paused) {
                stopPolling();
                report();
                hooks.state("paused");
              } else if (data === STATE.ended) {
                stopPolling();
                hooks.state("ended");
              }
            },
            onError({ data }) {
              const e = describeYouTubeError(data);
              if (!destroyed) hooks.failed(e.message, e.skip);
              // Before the player was ready this ends setup too.
              reject(new Error(e.message));
            },
            onAutoplayBlocked() {
              hooks.state("paused");
              hooks.failed("Your browser blocked autoplay. Press play in the player.", false);
            },
          },
        });
      });
    },
  };
}
