import { open, seal } from "../../llm/secretBox.js";

// Plugin settings live as plain JSON in the settings table. Anything secret in them
// (API keys, webhook secrets) is sealed first with a key derived from the server secret,
// the same box the AI DJ uses for provider keys, with its own purpose per plugin.

const purposeFor = (pluginId: string) => `plugin-config:${pluginId}`;

export function sealSecret(plain: string, serverSecret: string, pluginId: string): string {
  return seal(plain, serverSecret, purposeFor(pluginId));
}

export function openSecret(sealed: string | undefined | null, serverSecret: string, pluginId: string): string | null {
  if (!sealed) return null;
  return open(sealed, serverSecret, purposeFor(pluginId));
}

/** Show a secret that can't be recovered from the stored value: only whether one exists. */
export const hasSecret = (sealed: string | undefined | null): boolean => typeof sealed === "string" && sealed.length > 0;
