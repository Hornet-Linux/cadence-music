import { beforeEach, describe, expect, it } from "vitest";
import { useOnboarding, wizardMode } from "./onboardingStore";

const base = {
  web: true,
  manual: false,
  serverStatus: "online" as const,
  signedIn: false,
  hasToken: false,
  hasError: false,
};

describe("wizardMode", () => {
  it("always shows on the desktop app", () => {
    expect(wizardMode({ ...base, web: false, signedIn: true })).toBe("show");
    expect(wizardMode({ ...base, web: false, serverStatus: "disconnected" })).toBe("show");
  });

  it("waits on the web until the server has answered", () => {
    expect(wizardMode({ ...base, serverStatus: "disconnected" })).toBe("wait");
    expect(wizardMode({ ...base, serverStatus: "checking" })).toBe("wait");
  });

  it("skips the whole wizard on the web when already signed in to the server serving the page", () => {
    expect(wizardMode({ ...base, signedIn: true })).toBe("skip");
  });

  it("waits for a saved session's profile, then skips", () => {
    expect(wizardMode({ ...base, hasToken: true })).toBe("wait");
    expect(wizardMode({ ...base, hasToken: true, signedIn: true })).toBe("skip");
  });

  it("shows the sign-in step when signed out, offline or the saved session failed", () => {
    expect(wizardMode(base)).toBe("show");
    expect(wizardMode({ ...base, serverStatus: "offline" })).toBe("show");
    expect(wizardMode({ ...base, hasToken: true, hasError: true })).toBe("show");
  });

  it("shows when the person opens it themselves, even when signed in", () => {
    expect(wizardMode({ ...base, manual: true, signedIn: true })).toBe("show");
  });
});

describe("onboarding store", () => {
  beforeEach(() => {
    localStorage.clear();
    useOnboarding.setState({ open: true, step: 0, manual: false });
  });

  it("marks a manual start and clears it on finish", () => {
    useOnboarding.getState().start();
    expect(useOnboarding.getState().manual).toBe(true);
    useOnboarding.getState().finish();
    const s = useOnboarding.getState();
    expect(s.open).toBe(false);
    expect(s.manual).toBe(false);
    expect(localStorage.getItem("onboarding:done")).toBe("1");
  });

  it("steps forward and never below the first step", () => {
    useOnboarding.getState().next();
    expect(useOnboarding.getState().step).toBe(1);
    useOnboarding.getState().back();
    useOnboarding.getState().back();
    expect(useOnboarding.getState().step).toBe(0);
  });
});
