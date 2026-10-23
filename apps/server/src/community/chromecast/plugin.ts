import type { ServerPlugin } from "../../plugins/types.js";
import { registerRendererRoutes } from "../_devices/rendererRoutes.js";
import { ChromecastManager, type ChromecastManagerOptions, type ManualCast } from "./manager.js";

export const CHROMECAST_PLUGIN_ID = "cadence.chromecast";

type Config = { manual?: ManualCast[]; streamBaseUrl?: string };

/**
 * Play to Chromecast devices over CASTV2 (TLS plus protobuf, implemented here without a dependency).
 * The Chromecast fetches audio from this server with a short-lived signed URL.
 */
export function createChromecastPlugin(
  options: Partial<Pick<ChromecastManagerOptions, "mdns" | "eurekaPort" | "session">> & { scanOnStart?: boolean } = {},
): ServerPlugin {
  return {
    id: CHROMECAST_PLUGIN_ID,
    name: "Chromecast",
    version: "1.0.0",
    description:
      "Plays to Chromecast devices on your network. The server finds them (or you add one by address) and hands each a short-lived signed stream link, so no account or cloud service is involved.",
    configFields: [
      { key: "streamBaseUrl", label: "Address devices use to reach this server", type: "url", placeholder: "http://192.168.1.10:8787", help: "Leave empty to use the address the player is connected with. Set it when that address is not reachable from the devices." },
    ],
    configNote:
      "Devices added by hand are kept in this plugin's saved settings; add or remove them in the player under Settings > Plugins > Chromecast.",
    register(app, ctx) {
      const manager = new ChromecastManager({
        ...options,
        store: {
          load: () => ctx.settings.pluginConfig<Config>(CHROMECAST_PLUGIN_ID)?.manual ?? [],
          save: (manual) =>
            ctx.settings.setPluginConfig(CHROMECAST_PLUGIN_ID, { ...ctx.settings.pluginConfig<Config>(CHROMECAST_PLUGIN_ID), manual }),
        },
      });
      registerRendererRoutes(app, ctx, { prefix: "chromecast", pluginId: CHROMECAST_PLUGIN_ID, backend: manager });
      app.addHook("onClose", async () => manager.close());
      if (options.scanOnStart !== false) ctx.jobs.every("chromecast-discovery", 5 * 60_000, () => manager.refresh(), { runSoon: true });
    },
  };
}

export default createChromecastPlugin();
