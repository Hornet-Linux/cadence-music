// Reading streamed replies. Dependency-free (plain Web streams) so the server,
// the desktop app and the web build can share it.

import { LlmError, type LlmMessage, type LlmTextRequest } from "./types.js";

/** Yield the lines of a response body as they arrive (without line breaks). */
export async function* readLines(res: Response): AsyncGenerator<string> {
  if (!res.body) throw new LlmError("The LLM server sent no data");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        yield buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer) yield buffer.replace(/\r$/, "");
  } finally {
    reader.releaseLock();
  }
}

/** The `data:` payloads of a server-sent event stream, in order. */
export async function* sseData(res: Response): AsyncGenerator<string> {
  for await (const line of readLines(res)) {
    if (line.startsWith("data:")) yield line.slice(5).trimStart();
  }
}

/** Combine an optional caller signal with a timeout. */
export function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

/** True when the server ignored `stream: true` and answered with one JSON document. */
export function isJsonReply(res: Response): boolean {
  return /application\/json/i.test(res.headers.get("content-type") ?? "");
}

const MAX_MESSAGES = 30;
const MAX_REQUEST_CHARS = 32_000;


/** Validate a plain-text chat request that crossed a trust boundary. */
export function parseTextRequest(value: unknown): LlmTextRequest {
  const v = value as Partial<LlmTextRequest> | null;
  if (!v || !Array.isArray(v.messages) || v.messages.length === 0 || v.messages.length > MAX_MESSAGES) {
    throw new LlmError("Invalid LLM request");
  }
  let chars = 0;
  const messages = v.messages.map((m) => {
    const role = (m as Partial<LlmMessage> | null)?.role;
    const content = (m as Partial<LlmMessage> | null)?.content;
    if ((role !== "system" && role !== "user" && role !== "assistant") || typeof content !== "string") {
      throw new LlmError("Invalid LLM request");
    }
    chars += content.length;
    return { role, content };
  });
  if (chars > MAX_REQUEST_CHARS) throw new LlmError("The request is too large");
  if (messages[messages.length - 1].role === "assistant") throw new LlmError("Invalid LLM request");
  const temperature = typeof v.temperature === "number" && Number.isFinite(v.temperature) ? Math.min(2, Math.max(0, v.temperature)) : undefined;
  return { messages, ...(temperature !== undefined ? { temperature } : {}) };
}
