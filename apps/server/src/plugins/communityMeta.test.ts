import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyBaseLogger } from "fastify";
import { listCommunityPlugins } from "./community.js";
import type { PluginConfigField } from "./types.js";

const TYPES = new Set(["text", "url", "secret", "number", "boolean", "select"]);

async function discover() {
  const errors: unknown[] = [];
  const log = { error: (...a: unknown[]) => errors.push(a) } as unknown as FastifyBaseLogger;
  const plugins = await listCommunityPlugins(log);
  assert.deepEqual(errors, [], "every community plugin loads");
  return plugins;
}

test("every community plugin describes itself for the admin Plugins page", async () => {
  const plugins = await discover();
  assert.ok(plugins.length >= 20, `found ${plugins.length} plugins`);
  const ids = new Set<string>();
  for (const p of plugins) {
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
    ids.add(p.id);
    assert.ok(p.description && p.description.length >= 40 && p.description.length <= 450, `${p.id} has a one- or two-sentence description`);
    assert.ok(Array.isArray(p.configFields), `${p.id} says what can be set (an empty list means nothing)`);
    if (p.configFields.length === 0) continue;
    const keys = new Set<string>();
    for (const f of p.configFields as PluginConfigField[]) {
      assert.ok(f.key && f.label, `${p.id}: field needs a key and a label`);
      assert.ok(!keys.has(f.key), `${p.id}: duplicate field ${f.key}`);
      keys.add(f.key);
      assert.ok(!f.key.includes("[]"), `${p.id}: ${f.key} is a list; lists are managed by the plugin's own screen`);
      assert.ok(TYPES.has(f.type ?? "text"), `${p.id}: unknown field type ${f.type}`);
      if (f.type === "select") assert.ok((f.options?.length ?? 0) > 0, `${p.id}: ${f.key} is a select without options`);
      if (f.sealed) assert.equal(f.type, "secret", `${p.id}: only secrets are sealed`);
    }
  }
});

test("plugins whose settings the form cannot edit say where to go instead", async () => {
  const plugins = await discover();
  const byId = new Map(plugins.map((p) => [p.id, p]));
  for (const id of ["cadence.webhooks", "cadence.home-assistant", "cadence.lyrics-translate", "cadence.now-playing"]) {
    const p = byId.get(id);
    assert.ok(p, `${id} is installed`);
    assert.deepEqual(p.configFields, []);
    assert.ok(p.configNote && p.configNote.length > 20, `${id} explains where its settings live`);
  }
  // Keys that the plugin stores encrypted through its own routes are never written by the generic form.
  const lidarr = byId.get("cadence.lidarr-slskd");
  assert.ok(lidarr?.configFields?.filter((f) => f.type === "secret").every((f) => f.sealed === true));
  assert.equal(byId.get("cadence.metrics")?.configFields?.[0]?.sealed, true);
  // Plugins that read plain settings use the shape their code reads.
  const transcode = byId.get("cadence.transcode");
  assert.deepEqual(transcode?.configFields?.map((f) => f.key), ["maxCacheMb", "defaultProfile", "liveStartAfterSec"]);
});
