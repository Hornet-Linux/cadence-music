import type { ReactNode } from "react";
import type { Track } from "@/shared/types";

/**
 * Plugin contracts for Unnamed Music App.
 *
 * Modeled on a capability-based, manifest-declared plugin system: a plugin
 * declares what it needs up front, the host reviews and grants it, and the
 * plugin receives a context whose surface is limited to its granted
 * capabilities. Built-in plugins ship inside the app; third-party plugins are
 * loaded from signed packages (see docs/PLUGINS.md).
 */

/** Granular capabilities a plugin may request. Shown to the user on install. */
export type Capability =
  | "player.read" // observe playback state (now playing, position)
  | "player.control" // start/pause/skip playback
  | "source.audio" // resolve a Track to a playable audio stream
  | "source.library" // import a library/playlists from an external service
  | "provider.lyrics" // supply lyrics for a track
  | "provider.metadata" // supply artwork/metadata for a track
  | "ui.sidebar" // contribute a navigation entry + page
  | "ui.home.widget" // contribute a widget to the Home view
  | "ui.settings" // contribute a settings panel
  | "storage" // read/write a small private key-value store
  | "network.outbound"; // make outbound HTTP requests

export interface PluginManifest {
  /** Reverse-DNS unique id, e.g. "obsoletelabs.tracking-bridge". */
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** Capabilities the plugin requests; the host grants on user consent. */
  capabilities: Capability[];
  /** Semver range of the plugin API this plugin targets. */
  apiRange: string;
  /** True for plugins that ship with the app and need no install/consent. */
  builtin?: boolean;
}

/** A sidebar navigation entry contributed by a plugin. */
export interface SidebarContribution {
  id: string;
  label: string;
  icon?: ReactNode;
  render: () => ReactNode;
}

/** A Home-view widget contributed by a plugin. */
export interface HomeWidgetContribution {
  id: string;
  title: string;
  render: () => ReactNode;
  /** Larger weights sort earlier on the Home view. */
  weight?: number;
}

/** A settings panel contributed by a plugin. */
export interface SettingsContribution {
  id: string;
  title: string;
  render: () => ReactNode;
}

/** An audio source that can turn a Track into a playable URL. */
export interface AudioSource {
  id: string;
  label: string;
  /** Return a playable media URL for the track, or null if it cannot. */
  resolve: (track: Track) => Promise<string | null>;
}

/** A library source that imports tracks/playlists from an external service. */
export interface LibrarySource {
  id: string;
  label: string;
  /** Begin the connect/import flow; resolves once import has been queued. */
  connect: () => Promise<void>;
}

/** Private per-plugin key-value storage (granted by the "storage" capability). */
export interface PluginStorage {
  get<T = unknown>(key: string): T | null;
  set(key: string, value: unknown): void;
  remove(key: string): void;
}

/**
 * The surface a plugin is handed on activation. Methods backed by a capability
 * the plugin did not request throw, so the manifest stays the source of truth.
 */
export interface PluginContext {
  manifest: PluginManifest;
  /** True if the capability was requested and granted. */
  can: (capability: Capability) => boolean;

  registerSidebarItem: (item: SidebarContribution) => void;
  registerHomeWidget: (widget: HomeWidgetContribution) => void;
  registerSettingsPanel: (panel: SettingsContribution) => void;
  registerAudioSource: (source: AudioSource) => void;
  registerLibrarySource: (source: LibrarySource) => void;

  /** Subscribe to now-playing changes. Returns an unsubscribe function. */
  onNowPlaying: (listener: (track: Track | null) => void) => () => void;

  storage: PluginStorage;
  /** Guarded fetch; only available with the "network.outbound" capability. */
  fetch: typeof fetch;

  log: (...args: unknown[]) => void;
}

export interface Plugin {
  manifest: PluginManifest;
  /** Called when the plugin is enabled. Register contributions here. */
  activate: (ctx: PluginContext) => void | Promise<void>;
  /** Called when the plugin is disabled. Optional cleanup. */
  deactivate?: () => void | Promise<void>;
}
