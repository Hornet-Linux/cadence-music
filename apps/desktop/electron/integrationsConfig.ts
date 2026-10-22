import fs from "node:fs";
import path from "node:path";

// Switches that must be set before the app is ready, so they cannot wait for a
// plugin to load. Kept in a small JSON file in the user-data folder; a plugin
// changes them through the bridge and the change applies after a restart.

export interface IntegrationsConfig {
  /** Turn on Chromium's system media controls (Windows media overlay, Linux MPRIS, macOS Now Playing). */
  systemMediaControls: boolean;
}

export const DEFAULT_CONFIG: IntegrationsConfig = { systemMediaControls: false };

export function parseConfig(raw: unknown): IntegrationsConfig {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { systemMediaControls: o.systemMediaControls === true };
}

/** The Chromium feature names to enable for these settings (empty when everything is off). */
export function featuresFor(config: IntegrationsConfig): string[] {
  return config.systemMediaControls ? ["HardwareMediaKeyHandling", "MediaSessionService"] : [];
}

export function readConfig(userDataDir: string): IntegrationsConfig {
  try {
    return parseConfig(JSON.parse(fs.readFileSync(path.join(userDataDir, "integrations.json"), "utf8")));
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function writeConfig(userDataDir: string, config: IntegrationsConfig): void {
  fs.writeFileSync(path.join(userDataDir, "integrations.json"), JSON.stringify(config), { mode: 0o600 });
}