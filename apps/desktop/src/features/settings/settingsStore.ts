import { create } from "zustand";

interface SettingsModalState {
  open: boolean;
  /** Section id: "playback", "appearance", a plugin panel id ("server", "spotify"…), "plugins", "about". */
  section: string;
  show: (section?: string) => void;
  close: () => void;
  select: (section: string) => void;
}

export const useSettingsModal = create<SettingsModalState>((set, get) => ({
  open: false,
  section: "playback",
  show: (section) => set({ open: true, section: section ?? get().section }),
  close: () => set({ open: false }),
  select: (section) => set({ section }),
}));
