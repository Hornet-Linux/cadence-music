import { randomBytes } from "node:crypto";
import type { AdminLlmProvider, AdminLlmProviderInput } from "@uma/shared";
import type { Db } from "../db.js";
import { transaction } from "../db.js";
import type { ProviderConfig } from "./core/index.js";
import { open, seal } from "./secretBox.js";

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

const toAdmin = (r: Row): AdminLlmProvider => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  baseUrl: r.base_url,
  model: r.model,
  hasKey: r.api_key_enc !== null,
  enabled: r.enabled === 1,
  isDefault: r.is_default === 1,
});

/** Providers the server owner configured. Keys stay encrypted in here. */
export class ProviderStore {
  constructor(
    private readonly db: Db,
    private readonly secret: string,
  ) {}

  private rows(): Row[] {
    return this.db.prepare("SELECT * FROM llm_providers ORDER BY created_at, id").all() as unknown as Row[];
  }

  private row(id: string): Row | undefined {
    return this.db.prepare("SELECT * FROM llm_providers WHERE id = ?").get(id) as unknown as Row | undefined;
  }

  list(): AdminLlmProvider[] {
    return this.rows().map(toAdmin);
  }

  get(id: string): AdminLlmProvider | undefined {
    const r = this.row(id);
    return r ? toAdmin(r) : undefined;
  }

  /** The config to call the provider with, key included. Server-side use only. */
  config(id: string): (ProviderConfig & { updatedAt: number }) | null {
    const r = this.db.prepare("SELECT * FROM llm_providers WHERE id = ? AND enabled = 1").get(id) as
      | (Row & { updated_at: number })
      | undefined;
    if (!r) return null;
    const apiKey = r.api_key_enc ? open(r.api_key_enc, this.secret) : null;
    if (r.api_key_enc && apiKey === null) return null; // key can't be decrypted: don't call without it
    return { kind: r.kind, baseUrl: r.base_url, model: r.model, ...(apiKey ? { apiKey } : {}), updatedAt: r.updated_at };
  }

  /** A saved key, for testing an edited provider without re-entering it. */
  apiKey(id: string): string | undefined {
    const r = this.row(id);
    return (r?.api_key_enc ? open(r.api_key_enc, this.secret) : null) ?? undefined;
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
          input.apiKey ? seal(input.apiKey, this.secret) : null,
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
      input.apiKey === undefined ? existing.api_key_enc : input.apiKey === "" ? null : seal(input.apiKey, this.secret);
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
