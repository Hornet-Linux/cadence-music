import { create } from "zustand";
import type { ControlInfo } from "../../../../electron/integrations";
import { createSettingsStore } from "../_desktop/settingsStore";
import type { MidiMapping } from "./midi";

export interface ControlSettings {
  port: number;
  /** Let remotes run commands registered by other plugins (off: playback commands only). */
  allowOthers: boolean;
  midiEnabled: boolean;
  mappings: MidiMapping[];
}

export const DEFAULT_PORT = 47321;

export const controlSettings = createSettingsStore<ControlSettings>({
  port: DEFAULT_PORT,
  allowOthers: false,
  midiEnabled: false,
  mappings: [],
});

export const useControlInfo = create<{ info: ControlInfo | null; set: (i: ControlInfo | null) => void }>((set) => ({
  info: null,
  set: (info) => set({ info }),
}));

export const useMidiState = create<{
  inputs: string[];
  error: string | null;
  /** Command waiting for the next MIDI message, when learning. */
  learning: string | null;
  lastSeen: string | null;
}>(() => ({ inputs: [], error: null, learning: null, lastSeen: null }));