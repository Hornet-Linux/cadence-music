import { create } from "zustand";

export type Route =
  | { kind: "home" }
  | { kind: "search" }
  | { kind: "library" }
  | { kind: "liked" }
  | { kind: "playlist"; playlistId: string }
  | { kind: "plugin"; itemId: string };

const MAX_HISTORY = 50;

interface NavState {
  route: Route;
  /** Earlier pages, most recent last. */
  back: Route[];
  /** Pages left by going back, most recent last. */
  forward: Route[];
  navigate: (route: Route) => void;
  goBack: () => void;
  goForward: () => void;
}

const same = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b);

export const useNav = create<NavState>((set, get) => ({
  route: { kind: "home" },
  back: [],
  forward: [],
  navigate: (route) => {
    const { route: current, back } = get();
    if (same(route, current)) return;
    set({ route, back: [...back, current].slice(-MAX_HISTORY), forward: [] });
  },
  goBack: () => {
    const { route, back, forward } = get();
    const previous = back[back.length - 1];
    if (!previous) return;
    set({ route: previous, back: back.slice(0, -1), forward: [...forward, route] });
  },
  goForward: () => {
    const { route, back, forward } = get();
    const next = forward[forward.length - 1];
    if (!next) return;
    set({ route: next, back: [...back, route], forward: forward.slice(0, -1) });
  },
}));

/** Mouse back/forward buttons and Alt+←/→ move through page history. */
export function startNavShortcuts(): void {
  window.addEventListener("mouseup", (e) => {
    if (e.button === 3) useNav.getState().goBack();
    if (e.button === 4) useNav.getState().goForward();
  });
  window.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      useNav.getState().goBack();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      useNav.getState().goForward();
    }
  });
}
