import { create } from "zustand";
import { createSettingsStore } from "../_desktop/settingsStore";
import { DEFAULT_OBS_SETTINGS, type ObsSettings } from "./overlay";

export const obsSettings = createSettingsStore<ObsSettings>(DEFAULT_OBS_SETTINGS);

export interface LinkInfo {
  id: number;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  viewers: number;
}

export const useObsState = create<{
  links: LinkInfo[] | null;
  /** Result of the last heartbeat, for the panel. */
  sending: { tone: "ok" | "warn"; text: string } | null;
  error: string | null;
}>(() => ({ links: null, sending: null, error: null }));