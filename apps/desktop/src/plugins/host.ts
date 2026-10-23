import { create } from "zustand";
import type { Track } from "@/shared/types";
import type {
  AudioEffect,
  AudioSource,
  Capability,
  CommandContribution,
  HomeWidgetContribution,
  LibrarySource,
  LyricsProvider,
  MetadataProvider,
  OutputTarget,
  PlaybackEvent,
  Plugin,
  PluginContext,
  PluginManifest,
  PluginStorage,
  PlayerApi,
  ResolvedAudio,
  SettingsContribution,
  SetupStepContribution,
  SidebarContribution,
  TrackActionContribution,
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
  setupSteps: SetupStepContribution[];
  audioSources: AudioSource[];
  librarySources: LibrarySource[];
  lyricsProviders: LyricsProvider[];
  metadataProviders: MetadataProvider[];
  audioEffects: AudioEffect[];
  outputTargets: OutputTarget[];
  commands: CommandContribution[];
  trackActions: TrackActionContribution[];
}

type NowPlayingListener = (track: Track | null) => void;
type PlaybackListener = (event: PlaybackEvent) => void;

// The player store registers itself here at start-up. The host never imports the
// player (the player imports the host), so plugins reach it through this handle.
let playerApi: PlayerApi | null = null;
export function setPlayerApi(api: PlayerApi) {
  playerApi = api;
}

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
  /** Notify plugins of a play / pause / seek / progress / end event. */
  emitPlayback: (event: PlaybackEvent) => void;
}

export function emptyContributions(): Contributions {
  return {
    sidebar: [],
    homeWidgets: [],
    settings: [],
    setupSteps: [],
    audioSources: [],
    librarySources: [],
    lyricsProviders: [],
    metadataProviders: [],
    audioEffects: [],
    outputTargets: [],
    commands: [],
    trackActions: [],
  };
}

// Now-playing and playback listeners live outside the store so plugins can subscribe
// without triggering React re-renders on every position tick. The sets are
// rebuilt together with the contributions and swapped in atomically.
let nowPlayingListeners = new Set<NowPlayingListener>();
let playbackListeners = new Set<PlaybackListener>();

// Enable/disable operations run one at a time; each rebuilds contributions
// from the state at the moment it runs, so concurrent toggles cannot
// overwrite each other's results.
let queue: Promise<void> = Promise.resolve();
function serialize(task: () => Promise<void>): Promise<void> {
  const run = queue.then(task);
  queue = run.catch(() => undefined);
  return run;
}

const ENABLED_KEY = "cadence.enabledPlugins";

/** Ids of non-builtin plugins the user turned on, so they stay on after a restart. */
function readSavedEnabled(): Set<string> {
  try {
    const raw = localStorage.getItem(ENABLED_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveEnabled(id: string, enabled: boolean): void {
  try {
    const ids = readSavedEnabled();
    if (enabled) ids.add(id);
    else ids.delete(id);
    localStorage.setItem(ENABLED_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage can be unavailable (private mode); the choice then lasts for this session only.
  }
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
  playback: Set<PlaybackListener>,
): PluginContext {
  const granted = new Set<Capability>(manifest.capabilities);
  const can = (cap: Capability) => granted.has(cap);
  const requireCap = (cap: Capability, what: string) => {
    if (!can(cap)) throw new Error(`Plugin ${manifest.id} lacks "${cap}" required for ${what}`);
  };
  // Looks the player up on each call, so plugins activated before it exists still work.
  const api = (cap: Capability, what: string): PlayerApi => {
    requireCap(cap, what);
    if (!playerApi) throw new Error("The player is not ready yet");
    return playerApi;
  };
  const player: PlayerApi = {
    getState: () => api("player.read", "player.getState").getState(),
    toggle: () => api("player.control", "player.toggle").toggle(),
    next: () => api("player.control", "player.next").next(),
    previous: () => api("player.control", "player.previous").previous(),
    seek: (s) => api("player.control", "player.seek").seek(s),
    setVolume: (v) => api("player.control", "player.setVolume").setVolume(v),
    playTracks: (tracks, start) => api("player.queue", "player.playTracks").playTracks(tracks, start),
    enqueue: (track) => api("player.queue", "player.enqueue").enqueue(track),
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
    registerSetupStep(step) {
      requireCap("ui.settings", "registerSetupStep");
      target.setupSteps.push(step);
    },
    registerAudioSource(source) {
      requireCap("source.audio", "registerAudioSource");
      target.audioSources.push(source);
    },
    registerLibrarySource(source) {
      requireCap("source.library", "registerLibrarySource");
      target.librarySources.push(source);
    },
    registerLyricsProvider(provider) {
      requireCap("provider.lyrics", "registerLyricsProvider");
      target.lyricsProviders.push(provider);
    },
    registerMetadataProvider(provider) {
      requireCap("provider.metadata", "registerMetadataProvider");
      target.metadataProviders.push(provider);
    },
    registerAudioEffect(effect) {
      requireCap("audio.dsp", "registerAudioEffect");
      target.audioEffects.push(effect);
    },
    registerOutputTarget(output) {
      requireCap("output.device", "registerOutputTarget");
      target.outputTargets.push(output);
    },
    registerCommand(command) {
      requireCap("commands", "registerCommand");
      target.commands.push(command);
    },
    registerTrackAction(action) {
      requireCap("track.actions", "registerTrackAction");
      target.trackActions.push(action);
    },
    onNowPlaying(listener) {
      requireCap("player.read", "onNowPlaying");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onPlayback(listener) {
      requireCap("player.read", "onPlayback");
      playback.add(listener);
      return () => playback.delete(listener);
    },
    player,
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
    const playback = new Set<PlaybackListener>();
    for (const { plugin } of get().plugins) {
      if (enabledIds.has(plugin.manifest.id)) {
        await plugin.activate(makeContext(plugin.manifest, contributions, listeners, playback));
      }
    }
    contributions.homeWidgets.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    contributions.setupSteps.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    contributions.audioEffects.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return { contributions, listeners, playback };
  }

  return {
    plugins: [],
    contributions: emptyContributions(),

    register(plugin) {
      if (get().plugins.some((p) => p.plugin.manifest.id === plugin.manifest.id)) return;
      set((s) => ({ plugins: [...s.plugins, { plugin, enabled: false }] }));
      // Built-in plugins are trusted and activate immediately; others come back on if the user had turned them on.
      if (plugin.manifest.builtin || readSavedEnabled().has(plugin.manifest.id)) {
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

        // Remember the user's choice for plugins that are not built in. Only this plugin's entry changes,
        // so plugins that have not registered yet at start-up keep theirs.
        if (!entry.plugin.manifest.builtin) saveEnabled(id, enabled);

        const { contributions, listeners, playback } = await rebuild(enabledIds);
        nowPlayingListeners = listeners;
        playbackListeners = playback;
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

    emitPlayback(event) {
      for (const listener of playbackListeners) {
        try {
          listener(event);
        } catch {
          // A misbehaving plugin listener must not break playback.
        }
      }
    },
  };
});
