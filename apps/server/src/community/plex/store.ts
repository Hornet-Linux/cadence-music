import { randomBytes } from "node:crypto";
import type { Settings } from "../../settings.js";
import { open, seal } from "../../llm/secretBox.js";

const PURPOSE = "plex-tokens";
export const PLUGIN_ID = "cadence.plex";

/** What is kept per person. `clientId` exists before sign-in (the link flow needs it). */
interface Stored {
  clientId: string;
  serverUrl?: string;
  /** Sealed (encrypted) plex.tv token. */
  tokenEnc?: string;
  userName?: string;
  serverName?: string | null;
  libraryKey?: string;
  libraryTitle?: string;
}

export interface Connection {
  userId: number;
  clientId: string;
  serverUrl: string;
  /** Decrypted. Never leaves the server. */
  token: string;
  userName: string;
  serverName: string | null;
  library: { key: string; title: string } | null;
  /** The sealed form, to tell a reconnected person's new token from the one that failed. */
  tokenEnc: string;
}

/** Each person's Plex sign-in, kept in the plugin's per-user settings with the token encrypted at rest. */
export class ConnectionStore {
  constructor(
    private readonly settings: Settings,
    private readonly secret: string,
  ) {}

  private raw(userId: number): Stored | undefined {
    return this.settings.pluginUserConfig<Stored>(PLUGIN_ID, userId);
  }

  /** A stable client id per Cadence user, so Plex shows one device per person, not one per sign-in. */
  clientIdFor(userId: number): string {
    const existing = this.raw(userId)?.clientId;
    if (existing) return existing;
    const clientId = `cadence-${userId}-${randomBytes(8).toString("hex")}`;
    this.settings.setPluginUserConfig(PLUGIN_ID, userId, { clientId } satisfies Stored);
    return clientId;
  }

  get(userId: number): Connection | null {
    const row = this.raw(userId);
    if (!row?.tokenEnc || !row.serverUrl || !row.userName) return null;
    const token = open(row.tokenEnc, this.secret, PURPOSE);
    if (token === null) {
      // Sealed with a different server secret, or damaged: the person signs in again.
      this.forget(userId);
      return null;
    }
    return {
      userId,
      clientId: row.clientId,
      serverUrl: row.serverUrl,
      token,
      userName: row.userName,
      serverName: row.serverName ?? null,
      library: row.libraryKey && row.libraryTitle ? { key: row.libraryKey, title: row.libraryTitle } : null,
      tokenEnc: row.tokenEnc,
    };
  }

  save(c: Omit<Connection, "tokenEnc">): void {
    const stored: Stored = {
      clientId: c.clientId,
      serverUrl: c.serverUrl,
      tokenEnc: seal(c.token, this.secret, PURPOSE),
      userName: c.userName,
      serverName: c.serverName,
      ...(c.library ? { libraryKey: c.library.key, libraryTitle: c.library.title } : {}),
    };
    this.settings.setPluginUserConfig(PLUGIN_ID, c.userId, stored);
  }

  setLibrary(userId: number, library: { key: string; title: string }): void {
    const row = this.raw(userId);
    if (row) this.settings.setPluginUserConfig(PLUGIN_ID, userId, { ...row, libraryKey: library.key, libraryTitle: library.title });
  }

  /** Forget the sign-in but keep the client id (the person is still the same device). */
  forget(userId: number): void {
    const row = this.raw(userId);
    this.settings.setPluginUserConfig(PLUGIN_ID, userId, row ? ({ clientId: row.clientId } satisfies Stored) : null);
  }

  /** Forget only if the stored token is still the one that was rejected (the person may have signed in again meanwhile). */
  forgetIfSame(userId: number, tokenEnc: string): void {
    if (this.raw(userId)?.tokenEnc === tokenEnc) this.forget(userId);
  }
}