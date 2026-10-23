import { DiscIcon } from "@/ui/icons";
import { createEmbeddedPlayback } from "../_streaming/embedded";
import { buildStreamingPlugin } from "../_streaming/plugin";
import { createStreamingStore } from "../_streaming/store";
import type { ServiceInfo } from "../_streaming/types";
import { soundcloudDriver } from "./widget";

export const soundcloudInfo: ServiceInfo = {
  slug: "soundcloud",
  name: "SoundCloud",
  prefix: "soundcloud:",
  homepage: "https://soundcloud.com/",
  credit: { text: "Powered by SoundCloud", href: "https://soundcloud.com/" },
  termsHref: "https://developers.soundcloud.com/docs/api/terms-of-use",
  adminHelp:
    "Register an app at soundcloud.com (Your Apps) and paste its client ID and secret here. Add the redirect address below to the app. SoundCloud's API terms apply to this server.",
  capabilities: {
    works: [
      "Search public tracks, and see your likes and playlists after you connect your account.",
      "Play tracks in SoundCloud's own player, shown in a panel (it carries the uploader and SoundCloud branding).",
      "Open any track on SoundCloud.",
    ],
    limits: [
      "Tracks play only inside SoundCloud's player, so queue controls are limited to what its player reports. Closing the panel stops playback.",
      "Some tracks are preview-only or blocked outside SoundCloud; those open on SoundCloud instead.",
      "No downloading, offline use or stream capture, which SoundCloud's terms forbid.",
    ],
  },
};

export const useSoundCloud = createStreamingStore(soundcloudInfo);

/** SoundCloud search and library with playback in the official HTML5 Widget. */
export const soundcloudPlugin = buildStreamingPlugin({
  info: soundcloudInfo,
  store: useSoundCloud,
  description: "Search SoundCloud, see your likes and playlists, and play tracks in SoundCloud's official widget.",
  icon: <DiscIcon />,
  async resolve(track, id) {
    if (useSoundCloud.getState().playback[track.id] === "link") return null;
    return createEmbeddedPlayback({
      dock: {
        service: "SoundCloud",
        href: useSoundCloud.getState().links[track.id],
        hrefLabel: "Open on SoundCloud",
        credit: soundcloudInfo.credit,
        height: 200,
      },
      driver: soundcloudDriver(id),
    });
  },
});

export default soundcloudPlugin;
