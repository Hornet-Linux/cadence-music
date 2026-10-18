import { create } from "zustand";
import type { Track } from "@/shared/types";
import type {
  AudioSource,
  Capability,
  HomeWidgetContribution,
  LibrarySource,
  Plugin,
  PluginContext,
  PluginManifest,
  PluginStorage,
  SettingsContribution,
  SidebarContribution,
} from "./types";

export const PLUGIN_API_VERSION = "1.0.0";

interface InstalledPlugin {
  plugin: Plugin;
  enabled: boolean;
}

interface Contributions {
  sidebar: SidebarContribution[];
  homeWidgets: HomeWidgetContribution[];
  settings: SettingsContribution[];
  audioSources: AudioSource[];
  librarySources: LibrarySource[];
}

interface PluginHostState {
  plugins: InstalledPlugin[];
  contributions: Contributions;
  register: (plugin: Plugin) => void;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Resolve a track to a playable URL via the first source that can. */
  resolveAudio: (track: Track) => Promise<string | null>;
  /** Notify plugins that the now-playing track changed. */
  emitNowPlaying: (track: Track | null) => void;
}

function emptyContributions(): Contributions {
  return {
    sidebar: [],
    homeWidgets: [],
    settings: [],
    audioSources: [],
    librarySources: [],
  };
}

// Now-playing listeners live outside the store so plugins can subscribe
// without triggering React re-renders on every position tick.
const nowPlayingListeners = new Set<(track: Track | null) => void>();

function makeStorage(pluginId: string, granted: boolean): PluginStorage {
  const prefix = `plugin:${pluginId}:`;
  const ensure = () => {
    if (!granted) throw new Error(`Plugin ${pluginId} lacks the "storage" capability`);
  };
  return {
    get<T>(key: string): T | null {
      ensure();
      try {
        const raw = localStorage.getItem(prefix + key);
        return raw == null ? null : (JSON.parse(raw) as T);
      } catch {
        return null;
      }
    },
    set(key: string, value: unknown) {
      ensure();
      localStorage.setItem(prefix + key, JSON.stringify(value));
    },
    remove(key: string) {
      ensure();
      localStorage.removeItem(prefix + key);
    },
  };
}

function makeContext(
  manifest: PluginManifest,
  mutate: (fn: (c: Contributions) => void) => void,
): PluginContext {
  const granted = new Set<Capability>(manifest.capabilities);
  const can = (cap: Capability) => granted.has(cap);
  const requireCap = (cap: Capability, what: string) => {
    if (!can(cap)) throw new Error(`Plugin ${manifest.id} lacks "${cap}" required for ${what}`);
  };

  return {
    manifest,
    can,
    registerSidebarItem(item) {
      requireCap("ui.sidebar", "registerSidebarItem");
      mutate((c) => c.sidebar.push(item));
    },
    registerHomeWidget(widget) {
      requireCap("ui.home.widget", "registerHomeWidget");
      mutate((c) => c.homeWidgets.push(widget));
    },
    registerSettingsPanel(panel) {
      requireCap("ui.settings", "registerSettingsPanel");
      mutate((c) => c.settings.push(panel));
    },
    registerAudioSource(source) {
      requireCap("source.audio", "registerAudioSource");
      mutate((c) => c.audioSources.push(source));
    },
    registerLibrarySource(source) {
      requireCap("source.library", "registerLibrarySource");
      mutate((c) => c.librarySources.push(source));
    },
    onNowPlaying(listener) {
      requireCap("player.read", "onNowPlaying");
      nowPlayingListeners.add(listener);
      return () => nowPlayingListeners.delete(listener);
    },
    storage: makeStorage(manifest.id, can("storage")),
    fetch: (...args: Parameters<typeof fetch>) => {
      if (!can("network.outbound")) {
        return Promise.reject(new Error(`Plugin ${manifest.id} lacks "network.outbound"`));
      }
      return fetch(...args);
    },
    log: (...args: unknown[]) => console.log(`[plugin:${manifest.id}]`, ...args),
  };
}

export const usePluginHost = create<PluginHostState>((set, get) => ({
  plugins: [],
  contributions: emptyContributions(),

  register(plugin) {
    if (get().plugins.some((p) => p.plugin.manifest.id === plugin.manifest.id)) return;
    set((s) => ({ plugins: [...s.plugins, { plugin, enabled: false }] }));
    // Built-in plugins are trusted and activate immediately.
    if (plugin.manifest.builtin) void get().setEnabled(plugin.manifest.id, true);
  },

  async setEnabled(id, enabled) {
    const entry = get().plugins.find((p) => p.plugin.manifest.id === id);
    if (!entry || entry.enabled === enabled) return;

    if (enabled) {
      // Rebuild all contributions from scratch so ordering stays deterministic.
      const next = emptyContributions();
      const mutate = (fn: (c: Contributions) => void) => fn(next);
      for (const p of get().plugins) {
        if (p.plugin.manifest.id === id || p.enabled) {
          await p.plugin.activate(makeContext(p.plugin.manifest, mutate));
        }
      }
      next.homeWidgets.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
      set((s) => ({
        contributions: next,
        plugins: s.plugins.map((p) => (p.plugin.manifest.id === id ? { ...p, enabled: true } : p)),
      }));
    } else {
      await entry.plugin.deactivate?.();
      const next = emptyContributions();
      const mutate = (fn: (c: Contributions) => void) => fn(next);
      for (const p of get().plugins) {
        if (p.enabled && p.plugin.manifest.id !== id) {
          await p.plugin.activate(makeContext(p.plugin.manifest, mutate));
        }
      }
      next.homeWidgets.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
      set((s) => ({
        contributions: next,
        plugins: s.plugins.map((p) => (p.plugin.manifest.id === id ? { ...p, enabled: false } : p)),
      }));
    }
  },

  async resolveAudio(track) {
    for (const source of get().contributions.audioSources) {
      try {
        const url = await source.resolve(track);
        if (url) return url;
      } catch {
        // Try the next source.
      }
    }
    return null;
  },

  emitNowPlaying(track) {
    for (const listener of nowPlayingListeners) {
      try {
        listener(track);
      } catch {
        // A misbehaving plugin listener must not break playback.
      }
    }
  },
}));
