import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { PluginStorage } from "@/plugins/types";

/**
 * A small settings store for one plugin: a zustand hook for the UI, plus saving to the
 * plugin's private storage once `bind()` hands it the storage from `activate`.
 * `activate` can run many times, so `bind` is safe to repeat.
 */
export interface Prefs<T extends object> {
  use: UseBoundStore<StoreApi<T>>;
  get: () => T;
  set: (patch: Partial<T>) => void;
  /** Load saved values and save every later change. */
  bind: (storage: PluginStorage) => void;
}

export function createPrefs<T extends object>(key: string, defaults: T, sanitize: (value: T) => T = (v) => v): Prefs<T> {
  const use = create<T>(() => ({ ...defaults }));
  let storage: PluginStorage | null = null;
  return {
    use,
    get: () => use.getState(),
    set(patch) {
      const next = sanitize({ ...use.getState(), ...patch });
      use.setState(next, true);
      try {
        storage?.set(key, next);
      } catch {
        // Storage full or blocked: the setting still works until the app closes.
      }
    },
    bind(s) {
      storage = s;
      let saved: Partial<T> | null = null;
      try {
        saved = s.get<Partial<T>>(key);
      } catch {
        saved = null;
      }
      use.setState(sanitize({ ...defaults, ...(saved ?? {}) }), true);
    },
  };
}

export const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
