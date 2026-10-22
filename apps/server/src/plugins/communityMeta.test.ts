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
  for (const id of ["cadence.webhooks", "cadence.home-assistant", "cadence.lyrics-translate", "cadence.now-playing", "cadence.listen-along"]) {
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

test("the streaming plugins describe their credentials with the shared metadata", async () => {
  const byId = new Map((await discover()).map((p) => [p.id, p]));
  const expected: Record<string, { plain: string[]; sealed: string[] }> = {
    "cadence.youtube-music": { plain: [], sealed: ["apiKey"] },
    "cadence.deezer": { plain: ["appId"], sealed: ["appSecret"] },
    "cadence.soundcloud": { plain: ["clientId"], sealed: ["clientSecret"] },
    "cadence.tidal": { plain: ["clientId", "countryCode"], sealed: ["clientSecret"] },
  };
  for (const [id, want] of Object.entries(expected)) {
    const p = byId.get(id);
    assert.ok(p, `${id} is installed`);
    const fields = p.configFields ?? [];
    assert.deepEqual(fields.filter((f) => !f.sealed).map((f) => f.key), want.plain, id);
    assert.deepEqual(fields.filter((f) => f.sealed).map((f) => f.key), want.sealed, id);
    assert.ok(fields.every((f) => (f.sealed ? f.type === "secret" : f.type === "text")));
    assert.ok(p.configNote?.includes("stored encrypted"), `${id} says where the secrets are entered`);
  }
});
