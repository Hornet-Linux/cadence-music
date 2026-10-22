import { DiscIcon } from "@/ui/icons";
import { buildStreamingPlugin } from "../_streaming/plugin";
import { createStreamingStore } from "../_streaming/store";
import type { ServiceInfo } from "../_streaming/types";

export const tidalInfo: ServiceInfo = {
  slug: "tidal",
  name: "TIDAL",
  prefix: "tidal:",
  homepage: "https://tidal.com/",
  credit: { text: "Powered by TIDAL", href: "https://tidal.com/" },
  termsHref: "https://tidal.com/terms",
  adminHelp:
    "Create an app at developer.tidal.com and paste its client ID and secret here. Add the redirect address below to the app. TIDAL's developer terms apply to this server.",
  capabilities: {
    works: [
      "Search TIDAL's catalogue, and see your saved tracks and playlists after you connect your account.",
      "Open any track or playlist in TIDAL.",
    ],
    limits: [
      "TIDAL tracks do not play inside Cadence. TIDAL only allows audio through its own player SDK, and its terms for third-party apps could not be confirmed, so this plugin links out instead.",
      "No previews, downloads or offline use.",
    ],
  },
};

export const useTidal = createStreamingStore(tidalInfo);

/** TIDAL catalogue and library; tracks open in TIDAL. */
export const tidalPlugin = buildStreamingPlugin({
  info: tidalInfo,
  store: useTidal,
  description: "Search TIDAL and see your saved tracks and playlists. Tracks open in TIDAL; they do not play in Cadence.",
  icon: <DiscIcon />,
});

export default tidalPlugin;
