import { create } from "zustand";
import type { PluginStorage } from "../../types";

/**
 * A tiny settings store for one plugin: values live in the plugin's own private
 * storage (the "storage" capability) and the panel re-renders when they change.
 */
export function createSettingsStore<T extends object>(defaults: T, key = "settings") {
  let storage: PluginStorage | null = null;
  const useSettings = create<{ values: T; set: (patch: Partial<T>) => void }>((set, get) => ({
    values: defaults,
    set(patch) {
      const values = { ...get().values, ...patch };
      set({ values });
      try {
        storage?.set(key, values);
      } catch {
        // Storage full or unavailable: the setting still applies for this session.
      }
    },
  }));
  return {
    useSettings,
    /** Attach the plugin's storage and load what was saved. Call from activate(). */
    bind(s: PluginStorage) {
      storage = s;
      let saved: Partial<T> | null = null;
      try {
        saved = s.get<Partial<T>>(key);
      } catch {
        saved = null;
      }
      useSettings.setState({ values: { ...defaults, ...(saved && typeof saved === "object" ? saved : {}) } });
    },
    get: () => useSettings.getState().values,
    set: (patch: Partial<T>) => useSettings.getState().set(patch),
  };
}