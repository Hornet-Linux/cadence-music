import type { ServerPlugin } from "../../plugins/types.js";
import { registerRendererRoutes } from "../_devices/rendererRoutes.js";
import { DlnaManager, type DlnaManagerOptions } from "./manager.js";

export const DLNA_PLUGIN_ID = "cadence.dlna";

type Config = { manual?: string[]; streamBaseUrl?: string };

/**
 * Play to UPnP/DLNA MediaRenderers, which includes Sonos. The server finds speakers with SSDP and
 * sends them a short-lived signed stream URL, so the speaker fetches the audio from this server.
 */
export function createDlnaPlugin(options: { ssdp?: DlnaManagerOptions["ssdp"]; scanOnStart?: boolean } = {}): ServerPlugin {
  return {
    id: DLNA_PLUGIN_ID,
    name: "DLNA and Sonos",
    version: "1.0.0",
    register(app, ctx) {
      const manager = new DlnaManager({
        ssdp: options.ssdp,
        store: {
          load: () => ctx.settings.pluginConfig<Config>(DLNA_PLUGIN_ID)?.manual ?? [],
          save: (manual) =>
            ctx.settings.setPluginConfig(DLNA_PLUGIN_ID, { ...ctx.settings.pluginConfig<Config>(DLNA_PLUGIN_ID), manual }),
        },
        log: ctx.log,
      });
      registerRendererRoutes(app, ctx, { prefix: "dlna", pluginId: DLNA_PLUGIN_ID, backend: manager });
      if (options.scanOnStart !== false) ctx.jobs.every("dlna-discovery", 5 * 60_000, () => manager.refresh(), { runSoon: true });
    },
  };
}

export default createDlnaPlugin();
