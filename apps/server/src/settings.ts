import type { Config } from "./config.js";
import type { Db } from "./db.js";

export type SignupSetting = Config["signup"];

/**
 * Server settings an admin can change at runtime (from the admin panel).
 * Values saved here win; otherwise the .env configuration applies.
 */
export class Settings {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {}

  private read<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return undefined;
    }
  }

  private write(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), Date.now());
  }

  /** Effective sign-up policy: admin setting, else SIGNUP_MODE from .env. */
  signup(): SignupSetting {
    const saved = this.read<{ mode: "closed" | "open" | "invite"; inviteCode?: string }>("signup");
    if (!saved) return this.config.signup;
    if (saved.mode === "open") return { mode: "open" };
    if (saved.mode === "invite" && saved.inviteCode) return { mode: "invite", inviteCode: saved.inviteCode };
    return undefined;
  }

  setSignup(value: { mode: "closed" } | { mode: "open" } | { mode: "invite"; inviteCode: string }): void {
    this.write("signup", value);
  }

  /** The Jellyfin address saved from the admin API (JELLYFIN_URL, when set, wins over it). */
  savedJellyfinUrl(): string | undefined {
    return this.read<string>("jellyfin:serverUrl");
  }

  setSavedJellyfinUrl(url: string | null): void {
    if (url) this.write("jellyfin:serverUrl", url);
    else this.db.prepare("DELETE FROM settings WHERE key = ?").run("jellyfin:serverUrl");
  }

  /** The Jellyfin address in effect, and where it came from. */
  jellyfin(): { serverUrl: string | null; source: "env" | "admin" | null } {
    if (this.config.jellyfinUrl) return { serverUrl: this.config.jellyfinUrl, source: "env" };
    const saved = this.savedJellyfinUrl();
    return saved ? { serverUrl: saved, source: "admin" } : { serverUrl: null, source: null };
  }

  /** Whether the admin turned a community plugin on (they all start off). */
  pluginEnabled(id: string): boolean {
    return this.read<boolean>(`plugin:${id}:enabled`) === true;
  }

  setPluginEnabled(id: string, enabled: boolean): void {
    this.write(`plugin:${id}:enabled`, enabled);
  }

  /** A plugin's own saved configuration (addresses, keys). Plain JSON, kept in the server database. */
  pluginConfig<T>(id: string): T | undefined {
    return this.read<T>(`plugin:${id}:config`);
  }

  setPluginConfig(id: string, value: unknown | null): void {
    if (value === null) this.db.prepare("DELETE FROM settings WHERE key = ?").run(`plugin:${id}:config`);
    else this.write(`plugin:${id}:config`, value);
  }

  /** A plugin's saved configuration for one person (their own Last.fm key and so on). */
  pluginUserConfig<T>(id: string, userId: number): T | undefined {
    return this.read<T>(`plugin:${id}:user:${userId}`);
  }

  setPluginUserConfig(id: string, userId: number, value: unknown | null): void {
    const key = `plugin:${id}:user:${userId}`;
    if (value === null) this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    else this.write(key, value);
  }

  /**
   * Whether signed-in people may send free-form prompts through the server's AI
   * provider (song chat, playlist builder, taste summary). Off by default.
   * LLM_CHAT_ENABLED=1 or =0 in the environment wins over the admin setting.
   */
  llmChatEnabled(): boolean {
    const env = process.env.LLM_CHAT_ENABLED;
    if (env === "1") return true;
    if (env === "0") return false;
    return this.read<boolean>("llm:chatEnabled") === true;
  }

  /** True when the environment decides, so the admin setting has no effect. */
  llmChatLocked(): boolean {
    return process.env.LLM_CHAT_ENABLED === "1" || process.env.LLM_CHAT_ENABLED === "0";
  }

  setLlmChatEnabled(enabled: boolean): void {
    this.write("llm:chatEnabled", enabled);
  }

  /** A person's own Spotify app ID, saved so all their devices can use it. */
  userSpotifyClientId(userId: number): string | undefined {
    return this.read<string>(`user:${userId}:spotifyClientId`);
  }

  setUserSpotifyClientId(userId: number, clientId: string | null): void {
    if (clientId) this.write(`user:${userId}:spotifyClientId`, clientId);
    else this.db.prepare("DELETE FROM settings WHERE key = ?").run(`user:${userId}:spotifyClientId`);
  }
}
