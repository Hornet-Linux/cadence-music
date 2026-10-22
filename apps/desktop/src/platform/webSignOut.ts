import { resetLocalProviders } from "@/features/dj/providers";
import { forgetMusicKit } from "@/plugins/builtins/appleMusic/musickit";
import { useAppleMusic } from "@/plugins/builtins/appleMusic/appleMusicStore";
import { useSpotify } from "@/plugins/builtins/spotify/spotifyStore";

// Browser storage that belongs to the person using this browser, not to the
// Cadence account: another person signing in next must not inherit it.
const DEVICE_KEYS = [
  "secret:spotify.session", // Spotify refresh token + client ID
  "spotify:clientId",
  "dj:providers",
  "dj:provider",
  "dj:llm", // legacy single-provider setting
  "dj:device-id",
];
const DEVICE_KEY_PREFIXES = [
  "secret:dj.key.", // AI provider API keys
  "music.", // MusicKit's Apple Music user token
];

/**
 * Web sign-out: forget everything this browser holds for the previous person's
 * streaming services and AI providers, in storage and in memory, so the next
 * sign-in starts clean. The Cadence session token itself is cleared by the
 * caller.
 */
export async function clearWebDeviceData(): Promise<void> {
  try {
    for (const key of Object.keys(localStorage)) {
      if (DEVICE_KEYS.includes(key) || DEVICE_KEY_PREFIXES.some((p) => key.startsWith(p))) localStorage.removeItem(key);
    }
    sessionStorage.removeItem("auth:pending");
  } catch {
    // Storage unavailable: nothing was persisted.
  }

  // Spotify: disconnects the player and clears the refresh token + cached access token.
  await useSpotify.getState().logout();
  useSpotify.setState({ clientId: "", profile: null, tracks: [], total: 0, error: null });

  // Apple Music: MusicKit sign-out, then the store's library.
  await forgetMusicKit();
  useAppleMusic.setState({ status: "unavailable", tracks: [], total: 0, loading: false, error: null });

  resetLocalProviders();
}
