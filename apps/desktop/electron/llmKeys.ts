// API keys for AI providers saved on this device. Each key is stored together
// with the address (origin) it was saved for and is only ever sent there, so a
// compromised page can't point a saved key at a server of its choosing. The
// page never reads a saved key back: it names the provider by id and the host
// (Electron's main process, or the web host) attaches the key.
import { LlmError, parseProviderConfig, type ProviderConfig } from "../../server/src/llm/core/index";

export const DJ_KEY_PREFIX = "dj.key.";
const ID_RE = /^[\w-]{1,40}$/;

/** What the page sends to run a provider: the usual config, plus the id of a saved provider. */
export type LocalLlmConfig = ProviderConfig & { providerId?: string };

interface KeyStore {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

const originOf = (baseUrl: string) => new URL(baseUrl).origin;

export function keyName(providerId: unknown): string {
  if (typeof providerId !== "string" || !ID_RE.test(providerId)) throw new LlmError("Invalid provider");
  return DJ_KEY_PREFIX + providerId;
}

/** Stored form: {"origin":"https://api.openai.com","key":"sk-..."}. Older installs stored the bare key. */
function unpack(raw: string): { origin?: string; key: string } {
  try {
    const v = JSON.parse(raw) as { origin?: unknown; key?: unknown };
    if (v && typeof v.key === "string" && typeof v.origin === "string") return { origin: v.origin, key: v.key };
  } catch {
    // a bare key from before keys were bound
  }
  return { key: raw };
}

export async function saveKey(store: KeyStore, providerId: unknown, baseUrl: unknown, key: unknown): Promise<void> {
  const name = keyName(providerId);
  if (key === null || key === "") return store.delete(name);
  if (typeof key !== "string" || key.length > 512 || typeof baseUrl !== "string") throw new LlmError("Invalid API key");
  await store.set(name, JSON.stringify({ origin: originOf(parseProviderConfig({ kind: "ollama", baseUrl, model: "" }).baseUrl), key }));
}

export async function hasKey(store: KeyStore, providerId: unknown): Promise<boolean> {
  return !!(await store.get(keyName(providerId)));
}

/**
 * Validate a config from the page and attach the saved key for `providerId`,
 * but only when the provider still points at the address the key was saved
 * for. A key the page typed itself (testing a new provider) is used as given.
 */
export async function resolveConfig(store: KeyStore, value: unknown): Promise<ProviderConfig> {
  const providerId = (value as { providerId?: unknown } | null)?.providerId;
  const config = parseProviderConfig(value);
  if (config.apiKey || providerId === undefined) return config;
  const name = keyName(providerId);
  const raw = await store.get(name);
  if (!raw) return config;
  const saved = unpack(raw);
  const origin = originOf(config.baseUrl);
  if (saved.origin === undefined) {
    // A key saved before binding existed: bind it to the address it is used with now.
    await store.set(name, JSON.stringify({ origin, key: saved.key }));
  } else if (saved.origin !== origin) {
    throw new LlmError(`The saved API key is for ${saved.origin}. Enter the key again to use it with ${origin}.`);
  }
  return { ...config, apiKey: saved.key };
}
