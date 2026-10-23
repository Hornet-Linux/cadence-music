import { describe, expect, it } from "vitest";
import {
  acceleratorFromKeyEvent,
  acceleratorProblem,
  comparableAccelerator,
  displayAccelerator,
  findConflicts,
  isCommonShortcut,
  normalizeAccelerator,
  parseAccelerator,
} from "./accelerator";

describe("accelerators", () => {
  it("normalises spelling and modifier order", () => {
    expect(normalizeAccelerator("ctrl+alt+right")).toBe("Ctrl+Alt+Right");
    expect(normalizeAccelerator("Shift+Control+f5")).toBe("Ctrl+Shift+F5");
    expect(normalizeAccelerator("CommandOrControl+Up")).toBe("CmdOrCtrl+Up");
    expect(normalizeAccelerator("Ctrl++")).toBe("Ctrl+Plus");
    expect(normalizeAccelerator("medianexttrack")).toBe("MediaNextTrack");
  });

  it("rejects malformed accelerators", () => {
    for (const bad of ["", "Ctrl+", "+A", "Ctrl+A+B", "Ctrl+Banana", "Ctrl + A", "x".repeat(80), "Ctrl+Alt"]) {
      expect(parseAccelerator(bad), bad).toBeNull();
    }
    expect(parseAccelerator(5 as unknown as string)).toBeNull();
  });

  it("refuses global shortcuts that would steal typing", () => {
    expect(acceleratorProblem("A")).toMatch(/Ctrl, Alt or Cmd/);
    expect(acceleratorProblem("Shift+A")).toMatch(/Shift alone/);
    expect(acceleratorProblem("Left")).not.toBeNull();
    expect(acceleratorProblem("Ctrl+Alt+Right")).toBeNull();
    expect(acceleratorProblem("MediaPlayPause")).toBeNull();
    expect(acceleratorProblem("F9")).toBeNull();
    expect(acceleratorProblem("nonsense")).toMatch(/not a valid/);
  });

  it("folds CmdOrCtrl per platform for comparisons", () => {
    expect(comparableAccelerator("CmdOrCtrl+Up", "win32")).toBe("Ctrl+Up");
    expect(comparableAccelerator("CmdOrCtrl+Up", "darwin")).toBe("Meta+Up");
    expect(comparableAccelerator("Meta+Up", "darwin")).toBe("Meta+Up");
  });
});

describe("shortcut conflicts", () => {
  it("groups bindings that use the same keys, however they are spelled", () => {
    const conflicts = findConflicts(
      [
        { id: "play", accelerator: "ctrl+alt+p" },
        { id: "next", accelerator: "Ctrl+Alt+Right" },
        { id: "pause", accelerator: "Alt+Ctrl+P" },
        { id: "other", accelerator: "CmdOrCtrl+Alt+Right" },
        { id: "broken", accelerator: "???" },
      ],
      "win32",
    );
    expect(conflicts).toEqual([
      { accelerator: "Ctrl+Alt+P", ids: ["play", "pause"] },
      { accelerator: "Ctrl+Alt+Right", ids: ["next", "other"] },
    ]);
  });

  it("does not report a conflict when CmdOrCtrl maps elsewhere on macOS", () => {
    expect(
      findConflicts(
        [
          { id: "a", accelerator: "CmdOrCtrl+Up" },
          { id: "b", accelerator: "Ctrl+Up" },
        ],
        "darwin",
      ),
    ).toEqual([]);
  });

  it("warns about shortcuts other software already owns", () => {
    expect(isCommonShortcut("ctrl+c", "win32")).toBe(true);
    expect(isCommonShortcut("Ctrl+Alt+Right", "win32")).toBe(false);
  });
});

describe("recording a key press", () => {
  const e = (code: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) => ({
    key: "x",
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  });

  it("builds an accelerator from the physical key, ignoring Shift or Alt changing the character", () => {
    expect(acceleratorFromKeyEvent(e("KeyP", { ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+P");
    expect(acceleratorFromKeyEvent(e("ArrowRight", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+Right");
    expect(acceleratorFromKeyEvent(e("Digit1", { altKey: true }))).toBe("Alt+1");
    expect(acceleratorFromKeyEvent(e("F8"))).toBe("F8");
    expect(acceleratorFromKeyEvent(e("MediaTrackNext"))).toBe("MediaNextTrack");
  });

  it("waits while only modifiers are down", () => {
    expect(acceleratorFromKeyEvent(e("ControlLeft", { ctrlKey: true }))).toBeNull();
    expect(acceleratorFromKeyEvent(e("ShiftLeft", { shiftKey: true }))).toBeNull();
  });

  it("shows platform-friendly names", () => {
    expect(displayAccelerator("Ctrl+Alt+Meta+Right", "win32")).toBe("Ctrl + Alt + Win + Right");
    expect(displayAccelerator("CmdOrCtrl+Alt+Right", "darwin")).toBe("Cmd + Option + Right");
    expect(displayAccelerator("MediaPlayPause", "win32")).toBe("Play/Pause key");
  });
});