import type { Settings } from "../settings.js";
import type { NetPolicy } from "./net.js";

/** Settings shared by every "music from files elsewhere" plugin, kept under one id. */
export const SOURCES_SETTINGS_ID = "cadence.sources";

interface SourcesConfig {
  allowPrivateNetwork?: boolean;
}

/**
 * Whether sources may connect to addresses on private networks (a NAS or MinIO at home).
 * Off by default, because the address is typed by users and the server can see more than they can.
 * The owner turns it on in the plugin's admin settings or with SOURCES_ALLOW_PRIVATE_NETWORK=true.
 */
export function networkPolicy(settings: Settings, env: NodeJS.ProcessEnv = process.env): NetPolicy {
  if (/^(1|true|yes|on)$/i.test(env.SOURCES_ALLOW_PRIVATE_NETWORK?.trim() ?? "")) return { allowPrivate: true };
  return { allowPrivate: settings.pluginConfig<SourcesConfig>(SOURCES_SETTINGS_ID)?.allowPrivateNetwork === true };
}

export function setAllowPrivateNetwork(settings: Settings, allow: boolean): void {
  const current = settings.pluginConfig<SourcesConfig>(SOURCES_SETTINGS_ID) ?? {};
  settings.setPluginConfig(SOURCES_SETTINGS_ID, { ...current, allowPrivateNetwork: allow });
}

export function networkPolicySource(settings: Settings, env: NodeJS.ProcessEnv = process.env): "env" | "admin" | null {
  if (/^(1|true|yes|on)$/i.test(env.SOURCES_ALLOW_PRIVATE_NETWORK?.trim() ?? "")) return "env";
  return settings.pluginConfig<SourcesConfig>(SOURCES_SETTINGS_ID)?.allowPrivateNetwork === true ? "admin" : null;
}
