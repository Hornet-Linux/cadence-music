import type { ExternalPlayback, ExternalPlaybackEvent } from "@/plugins/types";
import { spotifyAccessToken, spotifyFetch } from "./api";
import type { SpotifyPlaybackState, SpotifyPlayer } from "./sdk";

// The Web Playback SDK turns this app into a Spotify Connect device. Requires
// Spotify Premium and a Widevine-capable (castlabs) Electron build.

const SDK_URL = "https://sdk.scdn.co/spotify-player.js";

let sdkLoading: Promise<void> | null = null;
let player: SpotifyPlayer | null = null;
let ready: Promise<string> | null = null;
const stateListeners = new Set<(state: SpotifyPlaybackState | null) => void>();

function loadSdk(): Promise<void> {
  if (window.Spotify) return Promise.resolve();
  if (!sdkLoading) {
    sdkLoading = new Promise<void>((resolve, reject) => {
      window.onSpotifyWebPlaybackSDKReady = () => resolve();
      const script = document.createElement("script");
      script.src = SDK_URL;
      script.async = true;
      script.onerror = () => {
        sdkLoading = null;
        script.remove();
        reject(new Error("Couldn't load the Spotify player"));
      };
      document.head.appendChild(script);
    });
  }
  return sdkLoading;
}

/** Start (once) the in-app Spotify Connect device; resolves to its device id. */
export function ensureSpotifyPlayer(): Promise<string> {
  if (!ready) {
    ready = (async () => {
      await loadSdk();
      const SpotifySdk = window.Spotify;
      if (!SpotifySdk) throw new Error("The Spotify player is unavailable");
      return await new Promise<string>((resolve, reject) => {
        const p = new SpotifySdk.Player({
          name: "Cadence",
          volume: 0.8,
          getOAuthToken: (cb) => {
            void spotifyAccessToken().then((token) => {
              if (token) cb(token);
            });
          },
        });
        const timer = setTimeout(
          () => reject(new Error("The Spotify player took too long to start")),
          20_000,
        );
        p.addListener("ready", ({ device_id }) => {
          clearTimeout(timer);
          resolve(device_id);
        });
        p.addListener("initialization_error", (e) => reject(new Error(`Spotify player: ${e.message}`)));
        p.addListener("authentication_error", (e) =>
          reject(new Error(`Spotify sign-in problem: ${e.message}`)),
        );
        p.addListener("account_error", () =>
          reject(new Error("Playing Spotify in the app needs a Spotify Premium account")),
        );
        p.addListener("playback_error", (e) => console.warn("Spotify playback error", e.message));
        p.addListener("player_state_changed", (state) => {
          for (const listener of stateListeners) listener(state);
        });
        player = p;
        void p.connect().then((ok) => {
          if (!ok) reject(new Error("Couldn't start the Spotify player"));
        });
      });
    })().catch((err) => {
      resetSpotifyPlayer();
      throw err;
    });
  }
  return ready;
}

export function resetSpotifyPlayer(): void {
  player?.disconnect();
  player = null;
  ready = null;
}

/** Load a Spotify track URI into the in-app player as an ExternalPlayback. */
export async function createSpotifyPlayback(uri: string): Promise<ExternalPlayback> {
  const deviceId = await ensureSpotifyPlayer();
  const p = player;
  if (!p) throw new Error("The Spotify player is unavailable");

  const listeners = new Set<(e: ExternalPlaybackEvent) => void>();
  const emit = (e: ExternalPlaybackEvent) => {
    for (const l of listeners) l(e);
  };

  let started = false;
  let stopped = false;
  let ended = false;
  let wasPlaying = false;
  let lastPosition = 0;
  let lastDuration = 0;
  let poll: ReturnType<typeof setInterval> | null = null;

  function finish() {
    if (ended) return;
    ended = true;
    stopPolling();
    emit({ playing: false, ended: true });
  }

  function onState(state: SpotifyPlaybackState | null) {
    if (stopped || ended || !state) return;
    const current = state.track_window.current_track?.uri;
    // Spotify moved on (e.g. its own autoplay) after our track finished.
    if (started && wasPlaying && current && current !== uri) return finish();
    if (current !== uri) return;

    // The SDK has no "ended" event: a track that was near its end and is now
    // paused at position 0 has finished.
    const nearEnd = lastDuration > 0 && lastPosition >= lastDuration - 2500;
    if (started && wasPlaying && state.paused && state.position === 0 && nearEnd) return finish();

    lastPosition = state.position;
    lastDuration = state.duration;
    wasPlaying = !state.paused;
    emit({ position: state.position / 1000, duration: state.duration / 1000, playing: !state.paused });
  }

  function startPolling() {
    stopPolling();
    poll = setInterval(() => {
      void p?.getCurrentState().then(onState);
    }, 500);
  }

  function stopPolling() {
    if (poll) clearInterval(poll);
    poll = null;
  }

  stateListeners.add(onState);

  return {
    async play() {
      if (stopped) return;
      if (!started) {
        started = true;
        await p.activateElement?.();
        await spotifyFetch(`me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
          method: "PUT",
          body: JSON.stringify({ uris: [uri] }),
        });
      } else {
        await p.resume();
      }
      startPolling();
    },
    async pause() {
      await p.pause();
      stopPolling();
    },
    async seek(seconds) {
      await p.seek(Math.max(0, Math.round(seconds * 1000)));
    },
    async setVolume(volume) {
      await p.setVolume(Math.min(1, Math.max(0, volume)));
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      stopPolling();
      stateListeners.delete(onState);
      if (started && !ended) await p.pause().catch(() => undefined);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
