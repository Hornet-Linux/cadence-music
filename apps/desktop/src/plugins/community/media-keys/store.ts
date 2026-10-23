import { create } from "zustand";
import { createSettingsStore } from "../_desktop/settingsStore";
import { DEFAULT_MEDIA_KEYS_SETTINGS, type EffectiveBinding, type MediaKeysSettings, type RegistrationPlan } from "./bindings";

export const mediaKeysSettings = createSettingsStore<MediaKeysSettings>(DEFAULT_MEDIA_KEYS_SETTINGS);

interface LiveState {
  bindings: EffectiveBinding[];
  plan: RegistrationPlan | null;
  /** The main process's answer per command: registered, or why not. */
  results: Record<string, { ok: boolean; error?: string }>;
  /** Whether the system media overlay switch is on (null until known). */
  systemControls: boolean | null;
  restartNeeded: boolean;
}

export const useShortcutState = create<LiveState>(() => ({
  bindings: [],
  plan: null,
  results: {},
  systemControls: null,
  restartNeeded: false,
}));