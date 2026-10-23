import type { HostBridge } from "../../../../electron/preload";
import type { Plugin } from "../../types";

// Helpers shared by the desktop-integration plugins (Discord, media keys, OBS,
// control API, status sync). This folder has no index file, so the plugin
// loader does not treat it as a plugin.

export type Integrations = HostBridge["integrations"];

/** The desktop bridge, or null in the browser, the Android and iOS apps (where none of this applies). */
export function desktopBridge(): Integrations | null {
  const host = typeof window === "undefined" ? undefined : window.host;
  if (!host || (host.platform as string) === "web" || !host.integrations) return null;
  return host.integrations;
}

/**
 * Plugins are collected when the page loads. In a browser the desktop bridge does not
 * exist yet at that moment, so these plugins are simply left out: nothing to enable,
 * nothing listed, nothing shown.
 */
export function desktopOnly(plugins: Plugin[]): Plugin[] {
  return desktopBridge() ? plugins : [];
}

export const hostPlatform = (): string => (typeof window === "undefined" ? "" : String(window.host?.platform ?? ""));