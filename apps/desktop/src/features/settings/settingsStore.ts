import { create } from "zustand";

interface SettingsModalState {
  open: boolean;
  /** Section id: "playback", "appearance", a plugin panel id ("server", "spotify"…), "plugins", "about". */
  section: string;
  /** Opened straight at a named section (phones then skip the section list). */
  deep: boolean;
  show: (section?: string) => void;
  close: () => void;
  select: (section: string) => void;
}

export const useSettingsModal = create<SettingsModalState>((set, get) => ({
  open: false,
  section: "playback",
  deep: false,
  show: (section) => set({ open: true, deep: section !== undefined, section: section ?? get().section }),
  close: () => set({ open: false }),
  select: (section) => set({ section }),
}));
