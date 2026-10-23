export type UpstreamFailure =
  | "not_found"
  | "not_configured"
  | "auth"
  | "rate_limited"
  | "busy"
  | "timeout"
  | "unreachable"
  | "bad_response";

/** A failed call to a metadata service, reduced to something safe to show a client. */
export class UpstreamError extends Error {
  constructor(
    readonly kind: UpstreamFailure,
    readonly provider?: string,
    readonly retryAfterSec?: number,
  ) {
    super(kind);
    this.name = "UpstreamError";
  }
}

/** HTTP status and body for an upstream failure. Never includes upstream text or addresses. */
export function describeFailure(e: UpstreamError): { status: number; headers?: Record<string, string>; body: { error: string; message: string; provider?: string } } {
  const who = e.provider ?? "The metadata service";
  switch (e.kind) {
    case "not_found":
      return { status: 404, body: { error: "not_found", message: "Nothing found", provider: e.provider } };
    case "not_configured":
      return {
        status: 501,
        body: { error: "not_configured", message: `${who} needs a key. Ask the server admin to add it.`, provider: e.provider },
      };
    case "auth":
      return {
        status: 502,
        body: { error: "upstream_auth", message: `${who} rejected the saved key.`, provider: e.provider },
      };
    case "rate_limited":
      return {
        status: 503,
        headers: { "retry-after": String(e.retryAfterSec ?? 5) },
        body: { error: "upstream_rate_limited", message: `${who} is limiting requests. Try again shortly.`, provider: e.provider },
      };
    case "busy":
      return { status: 503, headers: { "retry-after": "5" }, body: { error: "busy", message: "Too many lookups waiting. Try again shortly." } };
    case "timeout":
      return { status: 504, body: { error: "upstream_timeout", message: `${who} took too long to answer.`, provider: e.provider } };
    default:
      return { status: 502, body: { error: "upstream_failed", message: `${who} couldn't be reached or answered oddly.`, provider: e.provider } };
  }
}
