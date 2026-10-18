import type { Plugin } from "../types";
import type { Track } from "@/shared/types";
import { appleMusicPlugin } from "./appleMusic";
import { localFilesPlugin } from "./localFiles";
import { serverPlugin } from "./server";
import { spotifyPlugin } from "./spotify";

/**
 * Built-in and sample plugins. Built-in plugins (`builtin: true`) are trusted
 * and activate automatically. The others demonstrate the install/consent flow
 * and start disabled until the user enables them in Settings → Plugins.
 */

// A built-in player observer that logs now-playing — demonstrates player.read.
const nowPlayingLogPlugin: Plugin = {
  manifest: {
    id: "core.now-playing-log",
    name: "Now Playing Log",
    version: "1.0.0",
    description: "Writes the current track to the developer console.",
    author: "Unnamed Music App",
    capabilities: ["player.read"],
    apiRange: "^1.0.0",
    builtin: true,
  },
  activate(ctx) {
    ctx.onNowPlaying((track: Track | null) => {
      ctx.log(track ? `now playing: ${track.title}` : "playback stopped");
    });
  },
};

// A sample (non-builtin) plugin that bridges to the obsoletelabs "unnamed
// tracking app". It is a stub: it declares the capabilities such a bridge
// needs, adds a sidebar page, and shows how consent/permissions surface.
const trackingBridgePlugin: Plugin = {
  manifest: {
    id: "obsoletelabs.tracking-bridge",
    name: "Tracking App Bridge",
    version: "0.1.0",
    description:
      "Connects to a self-hosted Unnamed Tracking App instance and surfaces it inside the player.",
    author: "obsoletelabs",
    capabilities: ["ui.sidebar", "network.outbound", "storage"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSidebarItem({
      id: "tracking-bridge",
      label: "Tracking",
      render: () => (
        <div className="view">
          <header className="view-header">
            <h1>Tracking App Bridge</h1>
            <p className="muted">
              Point this at your self-hosted Unnamed Tracking App instance. Connection and import
              are not wired up yet — this is a scaffold showing where the bridge lives.
            </p>
          </header>
          <div className="card pad">
            <label className="field-label" htmlFor="tracking-url">
              Instance URL
            </label>
            <input id="tracking-url" className="text-input" placeholder="https://tracking.example.com" />
            <p className="muted small">
              Stored privately for this plugin via the <code>storage</code> capability.
            </p>
          </div>
        </div>
      ),
    });
  },
};

export const builtinPlugins: Plugin[] = [
  serverPlugin,
  spotifyPlugin,
  appleMusicPlugin,
  localFilesPlugin,
  nowPlayingLogPlugin,
];
export const samplePlugins: Plugin[] = [trackingBridgePlugin];
export const allRegisterablePlugins: Plugin[] = [...builtinPlugins, ...samplePlugins];
