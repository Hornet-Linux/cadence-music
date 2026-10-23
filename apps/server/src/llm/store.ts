import { randomBytes } from "node:crypto";
import type { AdminLlmProvider, AdminLlmProviderInput } from "@uma/shared";
import type { Db } from "../db.js";
import { transaction } from "../db.js";
import type { ProviderConfig } from "./core/index.js";
import { isBound, open, seal } from "./secretBox.js";


interface Row {
  id: string;
  name: string;
  kind: AdminLlmProvider["kind"];
  base_url: string;
  model: string;
  api_key_enc: string | null;
  enabled: number;
  is_default: number;
}

/** Providers the server owner configured. Keys stay encrypted in here. */
export class ProviderStore {
  /**
   * @param secret the server secret keys are sealed with.
   * @param previousSecrets older server secrets (PREVIOUS_SERVER_SECRET), still
   *   accepted for reading so the secret can be rotated without re-entering keys.
   */
  constructor(
    private readonly db: Db,
    private readonly secret: string,
    private readonly previousSecrets: readonly string[] = [],
  ) {}

  /** Each sealed key is bound to its provider id, so it can't be moved to another row. */
  private openKey(r: Pick<Row, "id" | "api_key_enc">): string | null {
    if (!r.api_key_enc) return null;
    for (const secret of [this.secret, ...this.previousSecrets]) {
      const plain = open(r.api_key_enc, secret, undefined, r.id);
      if (plain !== null) return plain;
    }
    return null;
  }

  private toAdmin(r: Row): AdminLlmProvider {
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      baseUrl: r.base_url,
      model: r.model,
      hasKey: r.api_key_enc !== null,
      ...(r.api_key_enc !== null && this.openKey(r) === null ? { keyUnreadable: true } : {}),
      enabled: r.enabled === 1,
      isDefault: r.is_default === 1,
    };
  }

  /**
   * Re-seal every key that is in the old unbound format or was sealed with a
   * previous secret. Returns the ids of providers whose key can't be read
   * with any known secret (they are skipped until an admin enters the key again).
   */
  migrateKeys(): { resealed: number; unreadable: string[] } {
    let resealed = 0;
    const unreadable: string[] = [];
    for (const r of this.rows()) {
      if (!r.api_key_enc) continue;
      const plain = this.openKey(r);
      if (plain === null) {
        unreadable.push(r.id);
        continue;
      }
      const current = isBound(r.api_key_enc) && open(r.api_key_enc, this.secret, undefined, r.id) !== null;
      if (current) continue;
      this.db.prepare("UPDATE llm_providers SET api_key_enc = ? WHERE id = ?").run(seal(plain, this.secret, undefined, r.id), r.id);
      resealed++;
    }
    return { resealed, unreadable };
  }

  private rows(): Row[] {
    return this.db.prepare("SELECT * FROM llm_providers ORDER BY created_at, id").all() as unknown as Row[];
  }

  private row(id: string): Row | undefined {
    return this.db.prepare("SELECT * FROM llm_providers WHERE id = ?").get(id) as unknown as Row | undefined;
  }

  list(): AdminLlmProvider[] {
    return this.rows().map((r) => this.toAdmin(r));
  }

  get(id: string): AdminLlmProvider | undefined {
    const r = this.row(id);
    return r ? this.toAdmin(r) : undefined;
  }

  /** The config to call the provider with, key included. Server-side use only. */
  config(id: string): (ProviderConfig & { updatedAt: number }) | null {
    const r = this.db.prepare("SELECT * FROM llm_providers WHERE id = ? AND enabled = 1").get(id) as
      | (Row & { updated_at: number })
      | undefined;
    if (!r) return null;
    const apiKey = this.openKey(r);
    if (r.api_key_enc && apiKey === null) return null; // key can't be decrypted: don't call without it
    return { kind: r.kind, baseUrl: r.base_url, model: r.model, ...(apiKey ? { apiKey } : {}), updatedAt: r.updated_at };
  }

  /** A saved key, for testing an edited provider without re-entering it. */
  apiKey(id: string): string | undefined {
    const r = this.row(id);
    return (r ? this.openKey(r) : null) ?? undefined;
  }

  create(input: AdminLlmProviderInput): AdminLlmProvider {
    const id = randomBytes(6).toString("hex");
    const now = Date.now();
    const first = this.rows().length === 0;
    transaction(this.db, () => {
      if (input.isDefault) this.db.exec("UPDATE llm_providers SET is_default = 0");
      this.db
        .prepare(
          `INSERT INTO llm_providers (id, name, kind, base_url, model, api_key_enc, enabled, is_default, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.kind,
          input.baseUrl,
          input.model,
          input.apiKey ? seal(input.apiKey, this.secret, undefined, id) : null,
          input.enabled === false ? 0 : 1,
          input.isDefault || first ? 1 : 0,
          now,
          now,
        );
    });
    return this.get(id)!;
  }

  update(id: string, input: AdminLlmProviderInput): AdminLlmProvider | undefined {
    const existing = this.row(id);
    if (!existing) return undefined;
    const apiKeyEnc =
      input.apiKey === undefined ? existing.api_key_enc : input.apiKey === "" ? null : seal(input.apiKey, this.secret, undefined, id);
    transaction(this.db, () => {
      if (input.isDefault) this.db.exec("UPDATE llm_providers SET is_default = 0");
      this.db
        .prepare(
          `UPDATE llm_providers SET name = ?, kind = ?, base_url = ?, model = ?, api_key_enc = ?,
             enabled = ?, is_default = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          input.name,
          input.kind,
          input.baseUrl,
          input.model,
          apiKeyEnc,
          input.enabled === false ? 0 : 1,
          (input.isDefault ?? existing.is_default === 1) ? 1 : 0,
          Date.now(),
          id,
        );
    });
    return this.get(id);
  }

  remove(id: string): boolean {
    const wasDefault = this.row(id)?.is_default === 1;
    const result = this.db.prepare("DELETE FROM llm_providers WHERE id = ?").run(id);
    if (wasDefault) {
      // Hand the default to the oldest provider that is left.
      this.db.exec(
        "UPDATE llm_providers SET is_default = 1 WHERE id = (SELECT id FROM llm_providers ORDER BY created_at, id LIMIT 1)",
      );
    }
    return Number(result.changes) > 0;
  }
}
