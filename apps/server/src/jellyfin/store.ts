import { randomBytes } from "node:crypto";
import type { Db } from "../db.js";
import { open, seal } from "../llm/secretBox.js";

const PURPOSE = "jellyfin-access-tokens";

export interface Connection {
  userId: number;
  jellyfinUserId: string;
  jellyfinUserName: string;
  serverName: string | null;
  /** The Jellyfin address the token was issued by. */
  serverUrl: string;
  /** Decrypted access token. Never leaves the server. */
  token: string;
  deviceId: string;
  /** The sealed form, to tell a reconnected person's new token from the one that failed. */
  tokenEnc: string;
}

interface Row {
  user_id: number;
  jellyfin_user_id: string;
  jellyfin_user_name: string;
  server_name: string | null;
  server_url: string;
  token_enc: string;
  device_id: string;
}

/** Each person's Jellyfin sign-in. Tokens are encrypted at rest with a key derived from the server secret. */
export class ConnectionStore {
  constructor(
    private readonly db: Db,
    private readonly secret: string,
  ) {}

  get(userId: number): Connection | null {
    const row = this.db.prepare("SELECT * FROM jellyfin_connections WHERE user_id = ?").get(userId) as Row | undefined;
    if (!row) return null;
    const token = open(row.token_enc, this.secret, PURPOSE);
    if (!token) {
      // Sealed with a different server secret, or damaged: it can't be used, so the person signs in again.
      this.delete(userId);
      return null;
    }
    return {
      userId,
      jellyfinUserId: row.jellyfin_user_id,
      jellyfinUserName: row.jellyfin_user_name,
      serverName: row.server_name,
      serverUrl: row.server_url,
      token,
      deviceId: row.device_id,
      tokenEnc: row.token_enc,
    };
  }

  /** A stable device id per Cadence user, so Jellyfin shows one device per person, not one per sign-in. */
  deviceIdFor(userId: number): string {
    const row = this.db.prepare("SELECT device_id FROM jellyfin_connections WHERE user_id = ?").get(userId) as
      | { device_id: string }
      | undefined;
    return row?.device_id ?? `cadence-${userId}-${randomBytes(8).toString("hex")}`;
  }

  save(c: Omit<Connection, "tokenEnc">): void {
    this.db
      .prepare(
        `INSERT INTO jellyfin_connections
           (user_id, jellyfin_user_id, jellyfin_user_name, server_name, server_url, token_enc, device_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET
           jellyfin_user_id = excluded.jellyfin_user_id, jellyfin_user_name = excluded.jellyfin_user_name,
           server_name = excluded.server_name, server_url = excluded.server_url, token_enc = excluded.token_enc,
           device_id = excluded.device_id, created_at = excluded.created_at`,
      )
      .run(
        c.userId,
        c.jellyfinUserId,
        c.jellyfinUserName,
        c.serverName,
        c.serverUrl,
        seal(c.token, this.secret, PURPOSE),
        c.deviceId,
        Date.now(),
      );
  }

  delete(userId: number): void {
    this.db.prepare("DELETE FROM jellyfin_connections WHERE user_id = ?").run(userId);
  }

  /** Delete only if the stored token is still the one that was rejected (the person may have signed in again meanwhile). */
  deleteIfToken(userId: number, tokenEnc: string): void {
    this.db.prepare("DELETE FROM jellyfin_connections WHERE user_id = ? AND token_enc = ?").run(userId, tokenEnc);
  }
}
