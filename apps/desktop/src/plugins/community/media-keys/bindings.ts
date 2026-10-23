import {
  acceleratorProblem,
  findConflicts,
  isCommonShortcut,
  normalizeAccelerator,
  type Binding,
  type BindingConflict,
  type Platform,
} from "../../../../electron/accelerator";
import type { CommandContribution } from "../../types";

/** Ids of the commands this plugin registers itself; their suggested shortcuts apply by default. */
export const OWN_PREFIX = "cadence.media-keys.";

export interface MediaKeysSettings {
  /**
   * What the person chose per command: an accelerator, or null for "no shortcut".
   * Commands not listed fall back to their suggestion (own commands only).
   */
  overrides: Record<string, string | null>;
}

export const DEFAULT_MEDIA_KEYS_SETTINGS: MediaKeysSettings = { overrides: {} };

export type BindingSource = "user" | "default" | "none";

export interface EffectiveBinding {
  id: string;
  title: string;
  accelerator: string | null;
  source: BindingSource;
  /** The shortcut the command suggests, if any. */
  suggestion: string | null;
}

/**
 * Work out which shortcut each command uses. A command from another plugin only gets a
 * global shortcut when the person picked one: a suggestion meant for in-app use (like
 * Ctrl+K) must not be grabbed system-wide behind their back.
 */
export function effectiveBindings(commands: CommandContribution[], settings: MediaKeysSettings): EffectiveBinding[] {
  const seen = new Set<string>();
  const out: EffectiveBinding[] = [];
  for (const c of commands) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const suggestion = c.shortcut ? normalizeAccelerator(c.shortcut) : null;
    if (Object.prototype.hasOwnProperty.call(settings.overrides, c.id)) {
      const chosen = settings.overrides[c.id];
      const accelerator = chosen ? normalizeAccelerator(chosen) : null;
      out.push({ id: c.id, title: c.title, accelerator, source: accelerator ? "user" : "none", suggestion });
    } else if (c.id.startsWith(OWN_PREFIX) && suggestion) {
      out.push({ id: c.id, title: c.title, accelerator: suggestion, source: "default", suggestion });
    } else {
      out.push({ id: c.id, title: c.title, accelerator: null, source: "none", suggestion });
    }
  }
  return out;
}

export interface RegistrationPlan {
  /** What to hand to the main process. */
  send: Binding[];
  /** Per command: why it was not registered. */
  problems: Record<string, string>;
  conflicts: BindingConflict[];
}

export function planRegistration(bindings: EffectiveBinding[], platform: Platform): RegistrationPlan {
  const problems: Record<string, string> = {};
  const usable: Binding[] = [];
  for (const b of bindings) {
    if (!b.accelerator) continue;
    const problem = acceleratorProblem(b.accelerator);
    if (problem) problems[b.id] = problem;
    else usable.push({ id: b.id, accelerator: b.accelerator });
  }
  const conflicts = findConflicts(usable, platform);
  // The first command in each clash keeps the shortcut; the others wait for the person to pick another.
  const loser = new Set<string>();
  for (const c of conflicts) {
    for (const id of c.ids.slice(1)) {
      loser.add(id);
      problems[id] = `Same keys as "${titleOf(bindings, c.ids[0]!)}"`;
    }
  }
  return { send: usable.filter((b) => !loser.has(b.id)), problems, conflicts };
}

const titleOf = (bindings: EffectiveBinding[], id: string) => bindings.find((b) => b.id === id)?.title ?? id;

/** A heads-up for a choice that works but may surprise: another app probably uses it too. */
export function shortcutWarning(accelerator: string, platform: Platform): string | null {
  return isCommonShortcut(accelerator, platform) ? "Other apps use this shortcut too" : null;
}

/** Update the overrides after the person records, clears or resets one shortcut. */
export function withOverride(settings: MediaKeysSettings, id: string, value: string | null | undefined): MediaKeysSettings {
  const overrides = { ...settings.overrides };
  if (value === undefined) delete overrides[id];
  else overrides[id] = value;
  return { overrides };
}

/** Suggested shortcuts for this plugin's own commands. */
export const OWN_COMMANDS: { name: string; title: string; shortcut: string }[] = [
  { name: "play-pause", title: "Play or pause", shortcut: "Ctrl+Alt+Space" },
  { name: "next", title: "Next track", shortcut: "Ctrl+Alt+Right" },
  { name: "previous", title: "Previous track", shortcut: "Ctrl+Alt+Left" },
  { name: "volume-up", title: "Volume up", shortcut: "Ctrl+Alt+Up" },
  { name: "volume-down", title: "Volume down", shortcut: "Ctrl+Alt+Down" },
  { name: "toggle-like", title: "Like or unlike this song", shortcut: "Ctrl+Alt+L" },
];

/** Position info for the system media overlay, or null when it would be invalid. */
export function positionState(duration: number, position: number, playing: boolean) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) return null;
  return { duration, position: Math.min(Math.max(0, position), duration), playbackRate: playing ? 1 : 0.0001 };
}