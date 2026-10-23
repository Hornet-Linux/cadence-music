import { create } from "zustand";
import type { DjPicksResponse, LlmProviderInfo, LlmProvidersResponse } from "@uma/shared";
import { useServer } from "@/plugins/builtins/server/serverStore";
import { isWeb } from "@/platform/webHost";
import { DEFAULT_LLM_CONFIG, extractJson, type LlmConfig, type LlmStatus, type ProviderKind } from "../../../electron/llm";
import { buildDjMessages, cleanReply, DJ_SCHEMA, type DjPick, type DjRequest } from "./prompt";
import type { TasteProfile } from "./tasteProfile";

// Where the AI DJ's model runs. A provider is one of:
//   server:<id>               the server owner's; the server calls it and keeps its key
//   device:<deviceId>:<id>    on another of this person's computers, reached through the server
//   local:<id>                on this device; this device calls it and keeps its key
//   native:ai                 the phone's own model (Apple Intelligence, Gemini Nano), via the app shell
// Keys typed on a device stay on that device (in secure storage), so a lost
// phone can't leak keys saved on the server or on other devices.

const PROVIDERS_KEY = "dj:providers";
const SELECTED_KEY = "dj:provider";
const LEGACY_CONFIG_KEY = "dj:llm";
const DEVICE_ID_KEY = "dj:device-id";
const SECRET_PREFIX = "dj.key.";

/** A provider configured on this device. The API key is kept apart, in secure storage. */
export interface LocalProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  /** Offer it to my other devices through the server (only while this app is open). */
  share: boolean;
}

export interface ProviderOption {
  ref: string;
  name: string;
  kind: ProviderKind | "native";
  model: string;
  scope: "local" | "server" | "device" | "native";
  /** Where it runs, for display: "This device", "Server" or the other computer's name. */
  where: string;
  isDefault?: boolean;
}

const DEFAULT_LOCAL: LocalProvider = {
  id: "ollama",
  name: "Ollama",
  kind: DEFAULT_LLM_CONFIG.kind,
  baseUrl: DEFAULT_LLM_CONFIG.baseUrl,
  model: DEFAULT_LLM_CONFIG.model,
  share: false,
};

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is optional.
  }
}

function loadLocal(): LocalProvider[] {
  const saved = read<LocalProvider[]>(PROVIDERS_KEY);
  if (saved?.length) return saved;
  // Carry over the single Ollama setting from before providers existed.
  const legacy = read<{ baseUrl?: string; model?: string }>(LEGACY_CONFIG_KEY);
  return [{ ...DEFAULT_LOCAL, baseUrl: legacy?.baseUrl ?? DEFAULT_LOCAL.baseUrl, model: legacy?.model ?? DEFAULT_LOCAL.model }];
}

/** A stable random id for this install, so the server can tell its devices apart. */
export function deviceId(): string {
  let id = "";
  try {
    id = localStorage.getItem(DEVICE_ID_KEY) ?? "";
  } catch {
    // Fall through to a per-session id.
  }
  if (!id) {
    id = `d-${crypto.randomUUID()}`;
    try {
      localStorage.setItem(DEVICE_ID_KEY, id);
    } catch {
      // Storage is optional.
    }
  }
  return id;
}

export async function getApiKey(id: string): Promise<string | undefined> {
  try {
    return (await window.host?.secrets?.get(SECRET_PREFIX + id)) ?? undefined;
  } catch {
    return undefined;
  }
}

async function setApiKey(id: string, key: string | null): Promise<void> {
  const secrets = window.host?.secrets;
  if (!secrets) return;
  try {
    if (key) await secrets.set(SECRET_PREFIX + id, key);
    else await secrets.delete(SECRET_PREFIX + id);
  } catch (err) {
    console.warn("Could not save the API key securely", err);
  }
}

/** Where typed API keys live: the desktop app uses the OS keychain, the website only this browser's storage. */
export function keyStorageNote(): string {
  return isWeb()
    ? "Stored in this browser and removed when you sign out."
    : "Kept in this device's secure storage.";
}

/** Forget every provider configured on this device (the web player does this on sign-out). */
export function resetLocalProviders(): void {
  useProviders.setState({ local: [{ ...DEFAULT_LOCAL }], selected: "", remote: [], native: null });
}

/** The config to call a local provider with, key included. */
export async function localConfig(p: LocalProvider): Promise<LlmConfig> {
  const apiKey = await getApiKey(p.id);
  return { kind: p.kind, baseUrl: p.baseUrl, model: p.model, ...(apiKey ? { apiKey } : {}) };
}

interface ProvidersState {
  local: LocalProvider[];
  /** What the listener picked ("" means: use the best one available). */
  selected: string;
  /** Providers the server and the person's other computers offer. */
  remote: LlmProviderInfo[];
  /** The phone's own model, when the app shell offers one that can run now. */
  native: { name: string } | null;

  addLocal: (p: Omit<LocalProvider, "id">, apiKey?: string) => Promise<string>;
  updateLocal: (id: string, patch: Partial<Omit<LocalProvider, "id">>, apiKey?: string | null) => Promise<void>;
  removeLocal: (id: string) => Promise<void>;
  select: (ref: string) => void;
  /** Reload what the server, the person's other computers and the app shell offer. */
  refreshRemote: () => Promise<void>;
}

export const useProviders = create<ProvidersState>((set, get) => ({
  local: loadLocal(),
  selected: read<string>(SELECTED_KEY) ?? "",
  remote: [],
  native: null,

  async addLocal(p, apiKey) {
    const id = Math.random().toString(36).slice(2, 10);
    if (apiKey) await setApiKey(id, apiKey);
    const local = [...get().local, { ...p, id }];
    set({ local });
    write(PROVIDERS_KEY, local);
    return id;
  },

  async updateLocal(id, patch, apiKey) {
    if (apiKey !== undefined) await setApiKey(id, apiKey);
    const local = get().local.map((p) => (p.id === id ? { ...p, ...patch } : p));
    set({ local });
    write(PROVIDERS_KEY, local);
  },

  async removeLocal(id) {
    await setApiKey(id, null);
    const local = get().local.filter((p) => p.id !== id);
    set({ local });
    write(PROVIDERS_KEY, local);
    if (get().selected === `local:${id}`) get().select("");
  },

  select(ref) {
    set({ selected: ref });
    write(SELECTED_KEY, ref);
  },

  async refreshRemote() {
    set({ native: await nativeOffer() });
    const server = useServer.getState();
    if (!server.user) return set({ remote: [] });
    try {
      set({ remote: (await server.api<LlmProvidersResponse>("api/llm/providers")).items });
    } catch {
      set({ remote: [] });
    }
  },
}));

const NATIVE_REF = "native:ai";

/** The app shell's on-device model, if it has one that is usable right now. */
async function nativeOffer(): Promise<{ name: string } | null> {
  const bridge = window.CadenceNative;
  if (!bridge) return null;
  try {
    return (await bridge.aiAvailable()) ? { name: bridge.aiName ?? "On-device AI" } : null;
  } catch {
    return null;
  }
}

/** On-device models have small context windows, so send them a trimmed profile. */
export function compactProfile(p: TasteProfile): TasteProfile {
  return {
    topArtists: p.topArtists.slice(0, 10),
    genres: p.genres.slice(0, 5),
    topTracks: p.topTracks.slice(0, 8),
    recentTracks: p.recentTracks.slice(0, 6),
  };
}

/** Everything the listener can pick from, server first. */
export function providerOptions(local: LocalProvider[], remote: LlmProviderInfo[], native: { name: string } | null = null): ProviderOption[] {
  return [
    ...remote
      .filter((r) => r.scope === "server")
      .map((r) => ({ ref: r.ref, name: r.name, kind: r.kind, model: r.model, scope: "server" as const, where: "Server", isDefault: r.isDefault })),
    ...remote
      .filter((r) => r.scope === "device")
      .map((r) => ({ ref: r.ref, name: r.name, kind: r.kind, model: r.model, scope: "device" as const, where: r.deviceName ?? "Another device" })),
    ...(native ? [{ ref: NATIVE_REF, name: native.name, kind: "native" as const, model: "on-device", scope: "native" as const, where: "This device" }] : []),
    ...local.map((p) => ({ ref: `local:${p.id}`, name: p.name, kind: p.kind, model: p.model, scope: "local" as const, where: "This device" })),
  ];
}

/**
 * The provider to use: the listener's pick if it still exists, otherwise the
 * server's default, otherwise the first one on this device.
 */
export function effectiveOption(selected: string, options: ProviderOption[]): ProviderOption | undefined {
  return (
    options.find((o) => o.ref === selected) ??
    options.find((o) => o.scope === "server" && o.isDefault) ??
    options.find((o) => o.scope === "server") ??
    // A phone's own model needs no setup, unlike a local server nobody has started.
    options.find((o) => o.scope === "native") ??
    options.find((o) => o.scope === "local")
  );
}

export function currentOption(): ProviderOption | undefined {
  const { local, remote, native, selected } = useProviders.getState();
  return effectiveOption(selected, providerOptions(local, remote, native));
}

function localById(ref: string): LocalProvider {
  const p = useProviders.getState().local.find((l) => `local:${l.id}` === ref);
  if (!p) throw new Error("That AI provider was removed. Pick another in Settings → AI DJ.");
  return p;
}

/** Is the provider reachable, and which models does it have? */
export async function providerStatus(ref: string): Promise<LlmStatus> {
  if (ref === NATIVE_REF) {
    const offer = await nativeOffer();
    return offer ? { available: true, models: ["on-device"] } : { available: false, models: [], error: "Not available on this device" };
  }
  if (ref.startsWith("local:")) {
    const llm = window.host?.llm;
    if (!llm) return { available: false, models: [], error: "Not available in this build" };
    return llm.status(await localConfig(localById(ref)));
  }
  return useServer.getState().api<LlmStatus>("api/llm/status", { method: "POST", body: JSON.stringify({ provider: ref }) });
}

export interface PickOptions extends Omit<DjRequest, "now"> {
  count: number;
}

/**
 * Ask the chosen provider for songs. A provider on this device is called from
 * here; anything else goes through the server, which owns the DJ's prompt.
 */
export async function requestPicks(ref: string, profile: TasteProfile, opts: PickOptions): Promise<DjPick[]> {
  if (ref === NATIVE_REF) {
    const bridge = window.CadenceNative;
    if (!bridge) throw new Error("This device has no on-device AI");
    const messages = buildDjMessages(compactProfile(profile), { ...opts, count: Math.min(opts.count, 8) });
    const request = JSON.stringify({ messages, schema: DJ_SCHEMA, temperature: 0.8 });
    return cleanReply(extractJson(await bridge.aiChatJson(request)));
  }
  if (ref.startsWith("local:")) {
    const llm = window.host?.llm;
    if (!llm) throw new Error("AI DJ isn't available here");
    const messages = buildDjMessages(profile, opts);
    return cleanReply(await llm.chatJson(await localConfig(localById(ref)), { messages, schema: DJ_SCHEMA as unknown as Record<string, unknown> }));
  }
  const res = await useServer.getState().api<DjPicksResponse>("api/dj/picks", {
    method: "POST",
    body: JSON.stringify({ provider: ref, profile, mood: opts.mood, switchUp: opts.switchUp, avoid: opts.avoid, count: opts.count, style: opts.style, notes: opts.notes }),
  });
  return res.picks;
}
