import { create } from "zustand";
import { setHostPersona } from "@/features/dj/hooks";
import type { PluginStorage } from "../../types";
import {
  CUSTOM_ID,
  INITIAL_STATE,
  parseState,
  resolvePersonality,
  sanitizeCustom,
  toPersona,
  type CustomPersonality,
  type PersonalityState,
} from "./personalities";

const KEY = "state";

interface Store extends PersonalityState {
  select: (id: string) => void;
  saveCustom: (custom: CustomPersonality) => void;
}

let storage: PluginStorage | null = null;

function persist(state: PersonalityState) {
  try {
    storage?.set(KEY, { selected: state.selected, custom: state.custom });
  } catch {
    // Storage is optional.
  }
}

/** Tell the DJ about the personality that is in effect. */
function apply(state: PersonalityState) {
  setHostPersona(toPersona(resolvePersonality(state)));
}

export const usePersonality = create<Store>((set, get) => ({
  ...INITIAL_STATE,
  select(id) {
    const next = parseState({ selected: id, custom: get().custom });
    set({ selected: next.selected });
    persist(next);
    apply(next);
  },
  saveCustom(custom) {
    const clean = sanitizeCustom(custom);
    const next = { selected: CUSTOM_ID, custom: clean };
    set(next);
    persist(next);
    apply(next);
  },
}));

/** Load the saved choice and apply it. Called when the plugin turns on. */
export function activatePersonality(pluginStorage: PluginStorage): void {
  storage = pluginStorage;
  let saved: unknown = null;
  try {
    saved = pluginStorage.get(KEY);
  } catch {
    saved = null;
  }
  const state = parseState(saved);
  usePersonality.setState(state);
  apply(state);
}

/** Back to the default DJ. Called when the plugin turns off. */
export function deactivatePersonality(): void {
  storage = null;
  setHostPersona(null);
}
