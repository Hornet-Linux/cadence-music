import type { Plugin } from "../../types";
import { RendererPanel } from "../_devices/RendererPanel";
import { createRendererTarget } from "../_devices/rendererOutput";

/** Play to speakers and TVs that speak UPnP/DLNA, including Sonos. Your Cadence server finds and drives them. */
const dlna: Plugin = {
  manifest: {
    id: "cadence.dlna",
    name: "DLNA and Sonos",
    version: "1.0.0",
    description:
      "Play on DLNA/UPnP speakers and TVs and on Sonos. Needs the DLNA server plugin turned on by your server admin. Browsers cannot search the network, so your server does it.",
    author: "Cadence",
    capabilities: ["output.device", "player.read", "player.control", "ui.settings", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerOutputTarget(createRendererTarget(ctx, { id: "cadence.dlna", label: "DLNA and Sonos", prefix: "dlna" }));
    ctx.registerSettingsPanel({
      id: "dlna",
      title: "DLNA and Sonos",
      description: "Speakers and TVs your server can play to.",
      keywords: ["upnp", "sonos", "cast", "speaker", "tv", "renderer"],
      render: () => (
        <RendererPanel
          prefix="dlna"
          noun="speakers and TVs"
          addressExample="192.168.1.20 (Sonos) or a description URL"
          note="Sonos speakers appear here too, labelled Sonos. Only tracks from your Cadence server or Jellyfin can be played; Spotify and local files play on this device."
        />
      ),
    });
  },
};

export default dlna;
