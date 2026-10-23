/** Small JSON client for the admin's own services (Lidarr, slskd). Timeouts, no redirects, errors with a status. */
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export type FetchFn = typeof fetch;

export interface JsonRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  fetchFn?: FetchFn;
}

export async function jsonRequest<T>(url: string, options: JsonRequest = {}): Promise<T> {
  const fetchFn = options.fetchFn ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: options.method ?? "GET",
      headers: { accept: "application/json", ...(options.body !== undefined ? { "content-type": "application/json" } : {}), ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "manual",
      signal,
    });
  } catch (err) {
    const reason = err instanceof Error ? (err.name === "TimeoutError" ? "timed out" : err.message) : String(err);
    throw new UpstreamError(`Could not reach ${new URL(url).host}: ${reason}`, 502);
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      // ignore
    }
    throw new UpstreamError(`${new URL(url).host} answered ${res.status}${detail ? `: ${detail}` : ""}`, res.status === 401 || res.status === 403 ? 401 : 502);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
