// Pure helpers for Electron accelerator strings ("Ctrl+Alt+Right"). Used by the
// main process (to validate what it registers) and by the settings panel (to
// record a key press and warn about conflicts). No Electron imports here.

export type Platform = "win32" | "darwin" | "linux" | string;

const MODIFIERS: Record<string, "Ctrl" | "Alt" | "Shift" | "Meta" | "CmdOrCtrl"> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  cmd: "Meta",
  command: "Meta",
  super: "Meta",
  meta: "Meta",
  alt: "Alt",
  option: "Alt",
  altgr: "Alt",
  shift: "Shift",
  cmdorctrl: "CmdOrCtrl",
  commandorcontrol: "CmdOrCtrl",
};

/** Keys that work without a modifier because they are not typed text. */
const STANDALONE_KEYS = new Set([
  "MediaPlayPause",
  "MediaNextTrack",
  "MediaPreviousTrack",
  "MediaStop",
  "VolumeUp",
  "VolumeDown",
  "VolumeMute",
]);

const NAMED_KEYS: Record<string, string> = {
  plus: "Plus",
  space: "Space",
  tab: "Tab",
  capslock: "Capslock",
  numlock: "Numlock",
  scrolllock: "Scrolllock",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  return: "Enter",
  enter: "Enter",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  escape: "Escape",
  esc: "Escape",
  printscreen: "PrintScreen",
  volumeup: "VolumeUp",
  volumedown: "VolumeDown",
  volumemute: "VolumeMute",
  medianexttrack: "MediaNextTrack",
  mediaprevioustrack: "MediaPreviousTrack",
  mediastop: "MediaStop",
  mediaplaypause: "MediaPlayPause",
  numdec: "numdec",
  numadd: "numadd",
  numsub: "numsub",
  nummult: "nummult",
  numdiv: "numdiv",
};

const PUNCTUATION = new Set([..."!@#$%^&*():;+=<,_-.>/?~`{[}]\\|\"'"]);

function normalizeKey(raw: string): string | null {
  const lower = raw.toLowerCase();
  const named = NAMED_KEYS[lower];
  if (named) return named;
  if (/^[a-z]$/i.test(raw)) return raw.toUpperCase();
  if (/^[0-9]$/.test(raw)) return raw;
  if (/^f([1-9]|1\d|2[0-4])$/i.test(raw)) return raw.toUpperCase();
  if (/^num[0-9]$/i.test(raw)) return `num${raw.slice(3)}`;
  if (raw.length === 1 && PUNCTUATION.has(raw)) return raw;
  return null;
}

export interface ParsedAccelerator {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** "CommandOrControl": Ctrl on Windows and Linux, Cmd on macOS. */
  cmdOrCtrl: boolean;
  key: string;
}

/** Parse an accelerator; null if it is not valid. */
export function parseAccelerator(input: string): ParsedAccelerator | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 60) return null;
  // "Ctrl++" means Ctrl and the plus key.
  const parts = input.endsWith("++") ? [...input.slice(0, -2).split("+"), "Plus"] : input.split("+");
  if (parts.some((p) => p.length === 0 || p !== p.trim())) return null;
  const parsed: ParsedAccelerator = { ctrl: false, alt: false, shift: false, meta: false, cmdOrCtrl: false, key: "" };
  for (const part of parts) {
    const mod = MODIFIERS[part.toLowerCase()];
    if (mod) {
      if (mod === "Ctrl") parsed.ctrl = true;
      else if (mod === "Alt") parsed.alt = true;
      else if (mod === "Shift") parsed.shift = true;
      else if (mod === "Meta") parsed.meta = true;
      else parsed.cmdOrCtrl = true;
      continue;
    }
    if (parsed.key) return null; // two non-modifier keys
    const key = normalizeKey(part);
    if (!key) return null;
    parsed.key = key;
  }
  return parsed.key ? parsed : null;
}

/**
 * Why an accelerator can't be used as a global shortcut, or null if it can.
 * A bare letter, digit or arrow key would steal typing from every other app.
 */
export function acceleratorProblem(input: string): string | null {
  const p = parseAccelerator(input);
  if (!p) return "That is not a valid shortcut";
  if (STANDALONE_KEYS.has(p.key) || /^F([1-9]|1\d|2[0-4])$/.test(p.key)) return null;
  if (!p.ctrl && !p.alt && !p.meta && !p.cmdOrCtrl) {
    return p.shift ? "Shift alone is not enough; add Ctrl, Alt or Cmd" : "Add Ctrl, Alt or Cmd, or use a media key";
  }
  return null;
}

/** Canonical spelling, e.g. "ctrl+alt+right" becomes "Ctrl+Alt+Right"; null when invalid. */
export function normalizeAccelerator(input: string): string | null {
  const p = parseAccelerator(input);
  if (!p) return null;
  const out: string[] = [];
  if (p.cmdOrCtrl) out.push("CmdOrCtrl");
  if (p.ctrl) out.push("Ctrl");
  if (p.alt) out.push("Alt");
  if (p.shift) out.push("Shift");
  if (p.meta) out.push("Meta");
  out.push(p.key);
  return out.join("+");
}

/** The key for comparing two accelerators on this platform ("CmdOrCtrl" folds into Ctrl or Meta). */
export function comparableAccelerator(input: string, platform: Platform): string | null {
  const p = parseAccelerator(input);
  if (!p) return null;
  const ctrl = p.ctrl || (p.cmdOrCtrl && platform !== "darwin");
  const meta = p.meta || (p.cmdOrCtrl && platform === "darwin");
  return [ctrl && "Ctrl", p.alt && "Alt", p.shift && "Shift", meta && "Meta", p.key].filter(Boolean).join("+");
}

export interface Binding {
  id: string;
  accelerator: string;
}

export interface BindingConflict {
  accelerator: string;
  /** Every binding id that uses it. */
  ids: string[];
}

/** Groups of bindings that would fight over the same keys. */
export function findConflicts(bindings: Binding[], platform: Platform): BindingConflict[] {
  const byKey = new Map<string, string[]>();
  for (const b of bindings) {
    const key = comparableAccelerator(b.accelerator, platform);
    if (!key) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), b.id]);
  }
  return [...byKey.entries()].filter(([, ids]) => ids.length > 1).map(([accelerator, ids]) => ({ accelerator, ids }));
}

/** Shortcuts the operating system or common apps already use; warn but don't forbid. */
const COMMON = [
  "Ctrl+C",
  "Ctrl+V",
  "Ctrl+X",
  "Ctrl+Z",
  "Ctrl+A",
  "Ctrl+S",
  "Ctrl+W",
  "Ctrl+Q",
  "Alt+F4",
  "Alt+Tab",
  "Meta+L",
  "Meta+D",
];

export function isCommonShortcut(input: string, platform: Platform): boolean {
  const key = comparableAccelerator(input, platform);
  return !!key && COMMON.some((c) => comparableAccelerator(c, platform) === key);
}

export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const KEY_BY_CODE: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  MediaPlayPause: "MediaPlayPause",
  MediaTrackNext: "MediaNextTrack",
  MediaTrackPrevious: "MediaPreviousTrack",
  MediaStop: "MediaStop",
  AudioVolumeUp: "VolumeUp",
  AudioVolumeDown: "VolumeDown",
  AudioVolumeMute: "VolumeMute",
  Equal: "=",
  Minus: "-",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
};

/**
 * Turn a keydown into an accelerator, or null while only modifiers are held.
 * Uses `code` for letters and digits so Shift or Alt don't change the key.
 */
export function acceleratorFromKeyEvent(e: KeyEventLike): string | null {
  const code = e.code ?? "";
  let key: string | null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^Numpad[0-9]$/.test(code)) key = `num${code.slice(6)}`;
  else if (/^F([1-9]|1\d|2[0-4])$/.test(code)) key = code;
  else key = KEY_BY_CODE[code] ?? null;
  if (!key) return null;
  const out: string[] = [];
  if (e.ctrlKey) out.push("Ctrl");
  if (e.altKey) out.push("Alt");
  if (e.shiftKey) out.push("Shift");
  if (e.metaKey) out.push("Meta");
  out.push(key);
  return normalizeAccelerator(out.join("+"));
}

/** A friendlier label for display ("Meta" is Win or Cmd depending on the platform). */
export function displayAccelerator(input: string, platform: Platform): string {
  const mac = platform === "darwin";
  return input
    .split("+")
    .map((part) => {
      if (part === "Meta") return mac ? "Cmd" : "Win";
      if (part === "CmdOrCtrl") return mac ? "Cmd" : "Ctrl";
      if (part === "Alt" && mac) return "Option";
      if (part === "MediaPlayPause") return "Play/Pause key";
      if (part === "MediaNextTrack") return "Next key";
      if (part === "MediaPreviousTrack") return "Previous key";
      if (part === "MediaStop") return "Stop key";
      return part;
    })
    .join(" + ");
}