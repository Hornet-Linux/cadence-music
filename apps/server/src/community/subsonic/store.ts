import type { Settings } from "../../settings.js";
import { open, seal } from "../../llm/secretBox.js";

const PURPOSE = "subsonic-passwords";
export const PLUGIN_ID = "cadence.subsonic";

interface Stored {
  serverUrl: string;
  username: string;
  /** Sealed (encrypted) password. Subsonic has no session tokens, so the password itself is what calls need. */
  passwordEnc: string;
  legacy?: boolean;
  serverName?: string | null;
}

export interface Connection {
  userId: number;
  serverUrl: string;
  username: string;
  /** Decrypted. Never leaves the server. */
  password: string;
  legacy: boolean;
  serverName: string | null;
  /** The sealed form, to tell a reconnected person's new password from the one that failed. */
  passwordEnc: string;
}

/** Each person's Subsonic sign-in, kept in the plugin's per-user settings with the password encrypted at rest. */
export class ConnectionStore {
  constructor(
    private readonly settings: Settings,
    private readonly secret: string,
  ) {}

  get(userId: number): Connection | null {
    const row = this.settings.pluginUserConfig<Stored>(PLUGIN_ID, userId);
    if (!row?.passwordEnc || !row.serverUrl || !row.username) return null;
    const password = open(row.passwordEnc, this.secret, PURPOSE);
    if (password === null) {
      // Sealed with a different server secret, or damaged: the person signs in again.
      this.delete(userId);
      return null;
    }
    return {
      userId,
      serverUrl: row.serverUrl,
      username: row.username,
      password,
      legacy: row.legacy === true,
      serverName: row.serverName ?? null,
      passwordEnc: row.passwordEnc,
    };
  }

  save(c: Omit<Connection, "passwordEnc">): void {
    const stored: Stored = {
      serverUrl: c.serverUrl,
      username: c.username,
      passwordEnc: seal(c.password, this.secret, PURPOSE),
      ...(c.legacy ? { legacy: true } : {}),
      serverName: c.serverName,
    };
    this.settings.setPluginUserConfig(PLUGIN_ID, c.userId, stored);
  }

  delete(userId: number): void {
    this.settings.setPluginUserConfig(PLUGIN_ID, userId, null);
  }

  /** Delete only if the stored password is still the one that was rejected (the person may have signed in again meanwhile). */
  deleteIfSame(userId: number, passwordEnc: string): void {
    if (this.settings.pluginUserConfig<Stored>(PLUGIN_ID, userId)?.passwordEnc === passwordEnc) this.delete(userId);
  }
}