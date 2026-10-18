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
}
