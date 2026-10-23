import { NoteIcon } from "@/ui/icons";
import { createEmbeddedPlayback } from "../_streaming/embedded";
import { buildStreamingPlugin } from "../_streaming/plugin";
import { createStreamingStore } from "../_streaming/store";
import type { ServiceInfo } from "../_streaming/types";
import { youtubeDriver } from "./player";

export const youtubeInfo: ServiceInfo = {
  slug: "youtube-music",
  name: "YouTube",
  prefix: "youtube:",
  homepage: "https://www.youtube.com/",
  credit: { text: "Powered by YouTube", href: "https://www.youtube.com/" },
  termsHref: "https://www.youtube.com/t/terms",
  adminHelp:
    "Create a YouTube Data API v3 key in your own Google Cloud project (Credentials, API key) and paste it here. It stays on your server. Keep to your key's quota; YouTube's API Services Terms of Service apply to this server.",
  capabilities: {
    works: [
      "Search for music videos that their owners allow to be embedded.",
      "Play them in YouTube's own player, shown in a panel while they play.",
      "Open any video on YouTube.",
    ],
    limits: [
      "There is no YouTube Music API, so there is no YouTube Music library, playlists, or Premium features.",
      "YouTube's rules require its player to stay visible and not be covered: audio-only or background playback is not allowed. Closing the panel stops playback, and it pauses when the app is in the background.",
      "No downloading, and no skipping of ads.",
      "Use the web player over http(s); YouTube's player does not work from a file:// page.",
      "By using this, you agree to the YouTube Terms of Service.",
    ],
  },
};

export const useYouTube = createStreamingStore(youtubeInfo);

/** YouTube search plus playback in YouTube's official, visible IFrame player. */
export const youtubePlugin = buildStreamingPlugin({
  info: youtubeInfo,
  store: useYouTube,
  description: "Search YouTube and play music videos in YouTube's official player (kept visible, as YouTube requires).",
  icon: <NoteIcon />,
  async resolve(_track, id) {
    return createEmbeddedPlayback({
      dock: {
        service: "YouTube",
        href: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
        hrefLabel: "Open on YouTube",
        credit: { text: "YouTube Terms of Service", href: youtubeInfo.termsHref },
        height: 215,
      },
      driver: youtubeDriver(id),
    });
  },
});

export default youtubePlugin;
