import type { ServerPlugin } from "../../plugins/types.js";

/** One setting of a plugin, described so a generic Plugins page can render a form for it. */
export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "url" | "secret" | "number" | "boolean" | "select";
  help?: string;
  options?: { value: string; label: string }[];
  /** Admin-only settings are the default; set when a regular user can read the value too. */
  public?: boolean;
}

/**
 * A server plugin that also describes itself: what it does, where its admin routes are and
 * which settings it keeps in `settings.pluginConfig(id)`. The extra fields are optional extras
 * for the admin UI; the server core only needs the `ServerPlugin` part.
 */
export interface DescribedPlugin extends ServerPlugin {
  description: string;
  /** Settings stored under settings.pluginConfig(id). Secret fields are encrypted at rest and never returned. */
  configFields: ConfigField[];
  /** Admin-only routes the plugin adds (for documentation). */
  adminRoutes: string[];
  /** Routes any signed-in user may call. */
  userRoutes?: string[];
}
