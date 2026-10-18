// Minimal typings for the Spotify Web Playback SDK
// (https://developer.spotify.com/documentation/web-playback-sdk).

export interface SpotifyPlaybackState {
  paused: boolean;
  /** Milliseconds. */
  position: number;
  /** Milliseconds. */
  duration: number;
  track_window: {
    current_track: { uri: string } | null;
  };
}

export interface SpotifyPlayerOptions {
  name: string;
  getOAuthToken: (callback: (token: string) => void) => void;
  volume?: number;
}

type ErrorEvent = "initialization_error" | "authentication_error" | "account_error" | "playback_error";

export interface SpotifyPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(event: "ready" | "not_ready", cb: (data: { device_id: string }) => void): boolean;
  addListener(event: "player_state_changed", cb: (state: SpotifyPlaybackState | null) => void): boolean;
  addListener(event: ErrorEvent, cb: (error: { message: string }) => void): boolean;
  getCurrentState(): Promise<SpotifyPlaybackState | null>;
  resume(): Promise<void>;
  pause(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  activateElement?(): Promise<void>;
}

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: { Player: new (options: SpotifyPlayerOptions) => SpotifyPlayer };
  }
}
