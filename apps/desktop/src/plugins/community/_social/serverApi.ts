import { useServer } from "@/plugins/builtins/server/serverStore";

/**
 * Helpers shared by the social and fun plugins. This folder has no index file, so it is not a
 * plugin itself and the plugin loader skips it.
 */

/** True while the person is signed in to a Cadence server. */
export function useSignedIn(): boolean {
  return useServer((s) => !!s.user);
}

/** Authenticated call to the server API (route relative to the server address). */
export function serverApi<T>(route: string, init?: RequestInit): Promise<T> {
  return useServer.getState().api<T>(route, init);
}

export interface SseEvent {
  event: string;
  data: string;
}

/** Split a chunk of a server-sent-events stream into whole events plus the unfinished tail. */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let rest = buffer.replace(/\r\n/g, "\n");
  let end: number;
  while ((end = rest.indexOf("\n\n")) >= 0) {
    const block = rest.slice(0, end);
    rest = rest.slice(end + 2);
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length > 0) events.push({ event, data: data.join("\n") });
  }
  return { events, rest };
}

/**
 * Read a server-sent-events route. The built-in EventSource cannot send the sign-in header, so this
 * reads the stream with fetch(). Returns a function that stops listening. `onEnd` fires once when
 * the stream closes or fails (unless it was stopped from here).
 */
export function openEventStream(
  route: string,
  handlers: { onEvent: (event: string, data: unknown) => void; onEnd: (error?: Error) => void },
): () => void {
  const { url, token } = useServer.getState();
  const controller = new AbortController();
  let stopped = false;
  void (async () => {
    try {
      if (!url) throw new Error("No server configured");
      const res = await fetch(new URL(route.replace(/^\/+/, ""), `${url}/`).toString(), {
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        let code = "";
        try {
          code = ((await res.json()) as { error?: string }).error ?? "";
        } catch {
          // Not JSON.
        }
        throw Object.assign(new Error(code || `Request failed (${res.status})`), { status: res.status, code });
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSse(buffer);
        buffer = parsed.rest;
        for (const e of parsed.events) {
          try {
            handlers.onEvent(e.event, JSON.parse(e.data));
          } catch {
            // Ignore an event that is not valid JSON.
          }
        }
      }
      if (!stopped) handlers.onEnd();
    } catch (err) {
      if (!stopped) handlers.onEnd(err instanceof Error ? err : new Error(String(err)));
    }
  })();
  return () => {
    stopped = true;
    controller.abort();
  };
}