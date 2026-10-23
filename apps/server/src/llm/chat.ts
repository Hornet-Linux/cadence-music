import type { LlmMessage, LlmProvider, LlmTextRequest } from "./core/index.js";
import { LlmError } from "./core/index.js";

// Free-form AI for plugins (song chat, playlist builder, taste summary). The
// client builds the prompt; the server only picks the provider, bounds the
// request and keeps the API key.

/** Free-form AI requests per person per window (the DJ has its own, smaller budget). */
export const CHAT_RATE_MAX = 60;
/** At most this many answers in flight for one person. */
export const CHAT_MAX_PARALLEL = 3;
export const MAX_STYLE = 400;
/** Longest reply the chat route relays; a runaway model is cut off here. */
export const MAX_CHAT_REPLY_CHARS = 20_000;

/** A line of text from a client: control characters become single spaces, trimmed and bounded. */
export function tidyLine(value: string, max: number): string {
  let out = "";
  let gap = false;
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    const control = c < 32 || (c >= 127 && c <= 159) || c === 0x2028 || c === 0x2029;
    if (control) {
      if (!gap) out += " ";
      gap = true;
    } else {
      out += ch;
      gap = false;
    }
  }
  return out.trim().slice(0, max).trim();
}

/** What providers that can't do plain text (a relayed device) answer instead. */
export const REPLY_SCHEMA = { type: "object", properties: { reply: { type: "string" } }, required: ["reply"] } as const;

export interface ChatBody {
  provider?: unknown;
  messages?: unknown;
  /** A JSON Schema: the reply is then JSON that follows it. */
  schema?: unknown;
  /** Send the text reply as server-sent events. */
  stream?: unknown;
  temperature?: unknown;
}

/** Text from a provider; one without plain-text chat is asked for a { reply } JSON object instead. */
export async function generateText(
  provider: LlmProvider,
  request: LlmTextRequest,
  onDelta?: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (provider.chatText) return provider.chatText(request, { onDelta, signal });
  const hint: LlmMessage = { role: "system", content: 'Reply with a JSON object like {"reply": "<your answer>"} and nothing else.' };
  const data = await provider.chatJson<{ reply?: unknown }>({
    messages: [hint, ...request.messages],
    temperature: request.temperature,
    schema: REPLY_SCHEMA as unknown as Record<string, unknown>,
  });
  const text = typeof data?.reply === "string" ? data.reply.trim() : "";
  if (!text) throw new LlmError("The model returned an empty reply");
  onDelta?.(text);
  return text;
}

/** One server-sent event. */
export const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
