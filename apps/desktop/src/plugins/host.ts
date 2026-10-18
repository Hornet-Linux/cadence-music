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
  ResolvedAudio,
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

type NowPlayingListener = (track: Track | null) => void;

interface PluginHostState {
  plugins: InstalledPlugin[];
  contributions: Contributions;
  register: (plugin: Plugin) => void;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Resolves once every queued enable/disable has finished. */
  whenIdle: () => Promise<void>;
  /** Make a track playable via the first audio source that can. */
  resolveAudio: (track: Track) => Promise<ResolvedAudio | null>;
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
// without triggering React re-renders on every position tick. The set is
// rebuilt together with the contributions and swapped in atomically.
let nowPlayingListeners = new Set<NowPlayingListener>();

// Enable/disable operations run one at a time; each rebuilds contributions
// from the state at the moment it runs, so concurrent toggles cannot
// overwrite each other's results.
let queue: Promise<void> = Promise.resolve();
function serialize(task: () => Promise<void>): Promise<void> {
  const run = queue.then(task);
  queue = run.catch(() => undefined);
  return run;
}

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
  target: Contributions,
  listeners: Set<NowPlayingListener>,
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
      target.sidebar.push(item);
    },
    registerHomeWidget(widget) {
      requireCap("ui.home.widget", "registerHomeWidget");
      target.homeWidgets.push(widget);
    },
    registerSettingsPanel(panel) {
      requireCap("ui.settings", "registerSettingsPanel");
      target.settings.push(panel);
    },
    registerAudioSource(source) {
      requireCap("source.audio", "registerAudioSource");
      target.audioSources.push(source);
    },
    registerLibrarySource(source) {
      requireCap("source.library", "registerLibrarySource");
      target.librarySources.push(source);
    },
    onNowPlaying(listener) {
      requireCap("player.read", "onNowPlaying");
      listeners.add(listener);
      return () => listeners.delete(listener);
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

export const usePluginHost = create<PluginHostState>((set, get) => {
  /** Activate every plugin in `enabledIds` into fresh contribution lists. */
  async function rebuild(enabledIds: Set<string>) {
    const contributions = emptyContributions();
    const listeners = new Set<NowPlayingListener>();
    for (const { plugin } of get().plugins) {
      if (enabledIds.has(plugin.manifest.id)) {
        await plugin.activate(makeContext(plugin.manifest, contributions, listeners));
      }
    }
    contributions.homeWidgets.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    return { contributions, listeners };
  }

  return {
    plugins: [],
    contributions: emptyContributions(),

    register(plugin) {
      if (get().plugins.some((p) => p.plugin.manifest.id === plugin.manifest.id)) return;
      set((s) => ({ plugins: [...s.plugins, { plugin, enabled: false }] }));
      // Built-in plugins are trusted and activate immediately.
      if (plugin.manifest.builtin) {
        void get()
          .setEnabled(plugin.manifest.id, true)
          .catch((err) => console.error(`Failed to enable ${plugin.manifest.id}`, err));
      }
    },

    setEnabled(id, enabled) {
      return serialize(async () => {
        const entry = get().plugins.find((p) => p.plugin.manifest.id === id);
        if (!entry || entry.enabled === enabled) return;

        const enabledIds = new Set(
          get()
            .plugins.filter((p) => p.enabled)
            .map((p) => p.plugin.manifest.id),
        );
        if (enabled) enabledIds.add(id);
        else {
          await entry.plugin.deactivate?.();
          enabledIds.delete(id);
        }

        const { contributions, listeners } = await rebuild(enabledIds);
        nowPlayingListeners = listeners;
        set((s) => ({
          contributions,
          plugins: s.plugins.map((p) => ({ ...p, enabled: enabledIds.has(p.plugin.manifest.id) })),
        }));
      });
    },

    whenIdle() {
      return queue;
    },

    async resolveAudio(track) {
      for (const source of get().contributions.audioSources) {
        try {
          const resolved = await source.resolve(track);
          if (resolved) return resolved;
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
  };
});
