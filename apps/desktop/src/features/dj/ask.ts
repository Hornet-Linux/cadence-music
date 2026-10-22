import { apiUrl, ApiError, useServer } from "@/plugins/builtins/server/serverStore";
import { isWeb } from "@/platform/webHost";
import { createLlmProvider, extractJson, type LlmMessage } from "../../../electron/llm";
import { currentOption, localConfig, useProviders, type ProviderOption } from "./providers";

// Free-form questions to the same AI provider the DJ uses (Settings → AI DJ):
// the server's, one of the person's other computers, a model on this device or
// the phone's own. The song chat, playlist builder and taste summary use this
// so there is one provider system, not several.

export const NO_PROVIDER_MESSAGE = "Add an AI provider in Settings → AI DJ first.";

/** Raised when nothing is configured; the UI shows a pointer to Settings → AI DJ instead of a red error. */
export class NoProviderError extends Error {
  constructor() {
    super(NO_PROVIDER_MESSAGE);
    this.name = "NoProviderError";
  }
}

export interface AskOptions {
  messages: LlmMessage[];
  temperature?: number;
  signal?: AbortSignal;
}

export interface AskTextOptions extends AskOptions {
  /** Called with each piece of the reply as it arrives (once with the whole reply when the provider can't stream). */
  onDelta?: (text: string) => void;
}

export interface AskJsonOptions extends AskOptions {
  schema: Record<string, unknown>;
}

const REPLY_SCHEMA = { type: "object", properties: { reply: { type: "string" } }, required: ["reply"] };
const NATIVE_REF = "native:ai";

/** The provider to use, after refreshing what the server and other devices offer. Throws NoProviderError. */
export async function requireProvider(): Promise<ProviderOption> {
  let option = currentOption();
  if (!option || option.scope === "local") {
    // A server provider may have been added since the app started.
    await useProviders.getState().refreshRemote().catch(() => undefined);
    option = currentOption();
  }
  if (!option) throw new NoProviderError();
  return option;
}

/** True once any provider is available right now (React-friendly check without refreshing). */
export function hasProvider(): boolean {
  return !!currentOption();
}

/** A message for the person that says what went wrong and, where it helps, what to do about it. */
export function describeAiError(e: unknown): string {
  if (e instanceof NoProviderError) return e.message;
  if (e instanceof DOMException && e.name === "AbortError") return "Stopped.";
  if (e instanceof ApiError) {
    if (e.code === "rate_limited") return "You've asked a lot in the last few minutes. Try again shortly.";
    if (e.code === "busy") return "The AI is still answering your other request. Try again in a moment.";
    if (e.code === "no_provider") return NO_PROVIDER_MESSAGE;
    if (e.code === "provider_not_found") return "That AI provider is no longer available. Pick another in Settings → AI DJ.";
    return e.message.replace(/^Request failed \(\d+\):?\s*/, "") || "The AI request failed.";
  }
  const text = e instanceof Error ? e.message : String(e);
  return text || "The AI request failed.";
}

function localProvider(ref: string) {
  const entry = useProviders.getState().local.find((l) => `local:${l.id}` === ref);
  if (!entry) throw new Error("That AI provider was removed. Pick another in Settings → AI DJ.");
  return entry;
}

function nativeBridge() {
  const bridge = window.CadenceNative;
  if (!bridge) throw new Error("This device has no on-device AI");
  return bridge;
}

/** Ask for a reply that follows a JSON schema. The caller validates it: models stray. */
export async function askJson<T = unknown>(ref: string, opts: AskJsonOptions): Promise<T> {
  if (ref === NATIVE_REF) {
    const request = JSON.stringify({ messages: opts.messages, schema: opts.schema, temperature: opts.temperature ?? 0.7 });
    return extractJson<T>(await nativeBridge().aiChatJson(request));
  }
  if (ref.startsWith("local:")) {
    const provider = localProvider(ref);
    const llm = window.host?.llm;
    if (!llm) throw new Error("AI isn't available here");
    return llm.chatJson<T>(await localConfig(provider), {
      messages: opts.messages,
      schema: opts.schema,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    });
  }
  const res = await useServer.getState().api<{ data: T }>("api/llm/chat", {
    method: "POST",
    signal: opts.signal,
    body: JSON.stringify({ provider: ref, messages: opts.messages, schema: opts.schema, temperature: opts.temperature }),
  });
  return res.data;
}

/** Ask for a plain-text reply, streamed when the provider can. Resolves to the whole reply. */
export async function askText(ref: string, opts: AskTextOptions): Promise<string> {
  if (ref === NATIVE_REF || ref.startsWith("local:")) {
    // The website calls a provider on this device straight from the page, where streaming works.
    if (ref.startsWith("local:") && isWeb()) {
      const provider = createLlmProvider(await localConfig(localProvider(ref)));
      if (provider.chatText) {
        return provider.chatText(
          { messages: opts.messages, ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}) },
          { onDelta: opts.onDelta, signal: opts.signal },
        );
      }
    }
    // The desktop app and the phone's own model answer in one piece.
    const data = await askJson<{ reply?: unknown }>(ref, {
      messages: [{ role: "system", content: 'Reply with a JSON object like {"reply": "<your answer>"} and nothing else.' }, ...opts.messages],
      schema: REPLY_SCHEMA,
      temperature: opts.temperature,
    });
    const text = typeof data?.reply === "string" ? data.reply.trim() : "";
    if (!text) throw new Error("The model returned an empty reply");
    opts.onDelta?.(text);
    return text;
  }
  return streamFromServer(ref, opts);
}

/** Read the server's server-sent-event answer from /api/llm/chat. */
async function streamFromServer(ref: string, opts: AskTextOptions): Promise<string> {
  const { url, token } = useServer.getState();
  if (!url) throw new Error("No server configured");
  const res = await fetch(apiUrl(url, "api/llm/chat"), {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    signal: opts.signal,
    body: JSON.stringify({ provider: ref, messages: opts.messages, temperature: opts.temperature, stream: true }),
  });
  if (!res.ok) {
    let code: string | undefined;
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      code = body.error;
      detail = body.message ? `: ${body.message}` : "";
    } catch {
      // Not JSON.
    }
    throw new ApiError(`Request failed (${res.status})${detail}`, res.status, code);
  }
  if (!res.body) throw new Error("The server sent no data");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSse(buffer);
    buffer = parsed.rest;
    for (const ev of parsed.events) {
      if (ev.event === "delta") {
        const piece = (safeJson(ev.data) as { text?: unknown } | null)?.text;
        if (typeof piece === "string" && piece) {
          text += piece;
          opts.onDelta?.(piece);
        }
      } else if (ev.event === "error") {
        const message = (safeJson(ev.data) as { message?: unknown } | null)?.message;
        throw new Error(typeof message === "string" ? message : "The AI provider failed.");
      }
    }
  }
  if (!text.trim()) throw new Error("The model returned an empty reply");
  return text;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Split a server-sent event stream into complete events and the unfinished tail. */
export function parseSse(buffer: string): { events: { event: string; data: string }[]; rest: string } {
  const parts = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = parts.pop() ?? "";
  const events = parts
    .map((block) => {
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      return { event, data: data.join("\n") };
    })
    .filter((e) => e.data || e.event !== "message");
  return { events, rest };
}
