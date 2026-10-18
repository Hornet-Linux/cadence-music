import { create } from "zustand";

const DONE_KEY = "onboarding:done";

function alreadyDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === "1";
  } catch {
    return false;
  }
}

interface OnboardingState {
  open: boolean;
  step: number;
  /** Open the wizard from the first step (e.g. from Settings). */
  start: () => void;
  next: () => void;
  back: () => void;
  /** Close and remember that setup was completed or skipped. */
  finish: () => void;
}

export const useOnboarding = create<OnboardingState>((set, get) => ({
  open: !alreadyDone(),
  step: 0,
  start: () => set({ open: true, step: 0 }),
  next: () => set({ step: get().step + 1 }),
  back: () => set({ step: Math.max(0, get().step - 1) }),
  finish() {
    try {
      localStorage.setItem(DONE_KEY, "1");
    } catch {
      // The wizard just shows again next launch.
    }
    set({ open: false, step: 0 });
  },
}));
