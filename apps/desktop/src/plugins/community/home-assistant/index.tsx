import type { Plugin } from "../../types";
import { HomeAssistantSettings } from "./HomeAssistantSettings";

/** Push now-playing to Home Assistant and take commands back, through your Cadence server. */
const homeAssistant: Plugin = {
  manifest: {
    id: "cadence.home-assistant",
    name: "Home Assistant",
    version: "1.0.0",
    description:
      "Shows what is playing in Home Assistant and lets Home Assistant pause, skip and change volume. Needs the Home Assistant and Remote control server plugins turned on by your server admin.",
    author: "Cadence",
    capabilities: ["ui.settings", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSettingsPanel({
      id: "home-assistant",
      title: "Home Assistant",
      description: "Now-playing in Home Assistant, and control from it.",
      keywords: ["smart home", "automation", "rest_command", "webhook"],
      render: () => <HomeAssistantSettings />,
    });
  },
};

export default homeAssistant;
