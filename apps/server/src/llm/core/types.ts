// Provider-neutral LLM types. This folder is dependency-free (plain fetch, no
// Node APIs) so the server, the desktop app and the web build can all use it.

/** Wire protocols we can speak. Most local servers use "openai-compatible". */
export type ProviderKind = "ollama" | "openai-compatible" | "anthropic";

export interface ProviderConfig {
  kind: ProviderKind;
  /** e.g. http://localhost:11434, http://localhost:1234/v1, https://api.openai.com/v1 */
  baseUrl: string;
  model: string;
  /** Sent as a bearer token (x-api-key for Anthropic). Never leaves the machine that owns it. */
  apiKey?: string;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmJsonRequest {
  messages: LlmMessage[];
  /** JSON Schema the reply must follow. */
  schema: Record<string, unknown>;
  temperature?: number;
}

export interface LlmStatus {
  /** False when the provider can't be reached or rejected our credentials. */
  available: boolean;
  models: string[];
  error?: string;
}

export interface LlmProvider {
  status(): Promise<LlmStatus>;
  /** Run a chat and return the reply parsed as JSON. */
  chatJson<T = unknown>(req: LlmJsonRequest): Promise<T>;
  /**
   * Run a chat and return the reply text, streaming it through `onDelta` when
   * the provider can. Absent on providers reached through a relay (JSON only).
   */
  chatText?(req: LlmTextRequest, options?: LlmTextOptions): Promise<string>;
}

export type FetchFn = typeof fetch;

/** A failure with a message that is safe to show the listener. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** A free-text chat (no JSON schema). */
export interface LlmTextRequest {
  messages: LlmMessage[];
  temperature?: number;
}

export interface LlmTextOptions {
  /** Called with each piece of the reply as it arrives (providers that can't stream call it once). */
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}
