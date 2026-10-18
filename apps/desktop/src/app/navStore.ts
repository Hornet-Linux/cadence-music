import { create } from "zustand";

export type Route =
  | { kind: "home" }
  | { kind: "search" }
  | { kind: "library" }
  | { kind: "plugin"; itemId: string };

interface NavState {
  route: Route;
  navigate: (route: Route) => void;
}

export const useNav = create<NavState>((set) => ({
  route: { kind: "home" },
  navigate: (route) => set({ route }),
}));
