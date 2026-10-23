import type { Plugin } from "../../types";
import { RendererPanel } from "../_devices/RendererPanel";
import { createRendererTarget } from "../_devices/rendererOutput";

/** Play to Chromecast devices. Your Cadence server finds and drives them (CASTV2). */
const chromecast: Plugin = {
  manifest: {
    id: "cadence.chromecast",
    name: "Chromecast",
    version: "1.0.0",
    description:
      "Play on Chromecast and Google Cast speakers and TVs. Needs the Chromecast server plugin turned on by your server admin. Browsers cannot search the network, so your server does it.",
    author: "Cadence",
    capabilities: ["output.device", "player.read", "player.control", "ui.settings", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerOutputTarget(createRendererTarget(ctx, { id: "cadence.chromecast", label: "Chromecast", prefix: "chromecast" }));
    ctx.registerSettingsPanel({
      id: "chromecast",
      title: "Chromecast",
      description: "Chromecast devices your server can play to.",
      keywords: ["cast", "google", "speaker", "tv"],
      render: () => (
        <RendererPanel
          prefix="chromecast"
          noun="Chromecasts"
          addressExample="192.168.1.30"
          note="A Chromecast fetches music from your server, so the server must be reachable from the Chromecast. Only tracks from your Cadence server or Jellyfin can be cast."
        />
      ),
    });
  },
};

export default chromecast;
