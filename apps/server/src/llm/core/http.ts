import { LlmError } from "./types.js";

export const CHAT_TIMEOUT_MS = 180_000;
export const STATUS_TIMEOUT_MS = 8_000;

/** Join `path` onto a base URL, keeping any path the base already has (e.g. /v1). */
export function endpoint(baseUrl: string, path: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new LlmError("That isn't a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new LlmError("LLM URL must be http(s)");
  const base = url.href.endsWith("/") ? url.href : url.href + "/";
  return new URL(path.replace(/^\//, ""), base).toString();
}

/** First 300 characters of an error body, for messages. */
export async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return text.slice(0, 300).trim();
}

export function describeFetchError(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "TimeoutError" || e.name === "AbortError") return "the request timed out";
    // Node's fetch hides the useful part in `cause` (ECONNREFUSED, ENOTFOUND...).
    const cause = (e as Error & { cause?: { code?: string; message?: string } }).cause;
    return cause?.code ?? cause?.message ?? e.message;
  }
  return String(e);
}

/**
 * Pull a JSON object out of model text. Models without strict structured
 * output wrap JSON in code fences or add a sentence around it.
 */
export function extractJson<T = unknown>(text: string): T {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) candidates.push(fenced[1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      // try the next candidate
    }
  }
  throw new LlmError("The model's reply wasn't valid JSON");
}
