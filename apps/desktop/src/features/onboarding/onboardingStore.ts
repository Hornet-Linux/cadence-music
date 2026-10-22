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
  /** True when the person asked for the wizard (Settings, Home) rather than it opening on first run. */
  manual: boolean;
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
  manual: false,
  start: () => set({ open: true, step: 0, manual: true }),
  next: () => set({ step: get().step + 1 }),
  back: () => set({ step: Math.max(0, get().step - 1) }),
  finish() {
    try {
      localStorage.setItem(DONE_KEY, "1");
    } catch {
      // The wizard just shows again next launch.
    }
    set({ open: false, step: 0, manual: false });
  },
}));

export type WizardMode = "wait" | "skip" | "show";

/**
 * Whether the first-run wizard should appear. On the desktop app it always does.
 * On the web player (and the phone apps) the page is served by the person's own
 * server, so there is no server to set up: wait until we know whether they are
 * signed in, then skip the wizard for anyone who already is.
 */
export function wizardMode(input: {
  web: boolean;
  manual: boolean;
  serverStatus: "disconnected" | "checking" | "online" | "offline";
  signedIn: boolean;
  hasToken: boolean;
  hasError: boolean;
}): WizardMode {
  if (!input.web || input.manual) return "show";
  if (input.serverStatus === "disconnected" || input.serverStatus === "checking") return "wait";
  if (input.signedIn) return "skip";
  // Online with a saved session whose profile is still loading.
  if (input.serverStatus === "online" && input.hasToken && !input.hasError) return "wait";
  return "show";
}
