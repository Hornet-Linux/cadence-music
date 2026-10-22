import { afterEach, describe, expect, it, vi } from "vitest";
import { changeNativeServer, isNativeApp } from "./webHost";

const win = window as unknown as Record<string, unknown>;

afterEach(() => {
  delete win.webkit;
  delete win.CadenceNative;
});

describe("Change server inside the phone apps", () => {
  it("is hidden in a plain browser", () => {
    expect(isNativeApp()).toBe(false);
    expect(() => changeNativeServer()).not.toThrow();
  });

  it("posts to the iOS app's message handler", () => {
    const postMessage = vi.fn();
    win.webkit = { messageHandlers: { cadence: { postMessage } } };
    expect(isNativeApp()).toBe(true);
    changeNativeServer();
    expect(postMessage).toHaveBeenCalledWith({ action: "changeServer" });
  });

  it("calls the Android app's bridge", () => {
    const changeServer = vi.fn();
    win.CadenceNative = { platform: "android", changeServer, aiAvailable: () => false, aiChatJson: async () => "" };
    expect(isNativeApp()).toBe(true);
    changeNativeServer();
    expect(changeServer).toHaveBeenCalledOnce();
  });

  it("ignores the iOS app's AI-only bridge, which has no Change server", () => {
    win.CadenceNative = { aiName: "Apple Intelligence", aiAvailable: () => true, aiChatJson: async () => "" };
    expect(isNativeApp()).toBe(false);
  });
});
