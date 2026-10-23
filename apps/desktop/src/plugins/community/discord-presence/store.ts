import { create } from "zustand";
import type { DiscordStatus } from "../../../../electron/presenceShared";
import { createSettingsStore } from "../_desktop/settingsStore";
import { DEFAULT_PRESENCE_SETTINGS, type PresenceSettings } from "./presence";

export const presenceSettings = createSettingsStore<PresenceSettings>(DEFAULT_PRESENCE_SETTINGS);

/** The connection state reported by the app's main process. */
export const useDiscordStatus = create<{ status: DiscordStatus; set: (s: DiscordStatus) => void }>((set) => ({
  status: { state: "off" },
  set: (status) => set({ status }),
}));