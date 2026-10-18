import { create } from "zustand";

interface UiState {
  queueOpen: boolean;
  toggleQueue: () => void;
  closeQueue: () => void;
}

export const useUi = create<UiState>((set, get) => ({
  queueOpen: false,
  toggleQueue: () => set({ queueOpen: !get().queueOpen }),
  closeQueue: () => set({ queueOpen: false }),
}));
