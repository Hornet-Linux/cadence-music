export interface SseEvent {
  event: string;
  data: unknown;
}

export interface SseStream {
  events: SseEvent[];
  /** Resolves with the first matching event (already received or yet to come). */
  // Test helper: callers read fields off the parsed JSON without declaring a type for every event.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  waitFor(event: string, match?: (data: any) => boolean, timeoutMs?: number): Promise<any>;
  /** Resolves once the server ends the stream. */
  closed: Promise<void>;
  close(): void;
}

/** A tiny server-sent-events reader for tests: sends the bearer token the way the real players do. */
export async function openSse(url: string, token: string): Promise<SseStream> {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: ctrl.signal });
  if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
  const events: SseEvent[] = [];
  const waiters: (() => void)[] = [];
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  void (async () => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let event = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (data) {
            events.push({ event, data: JSON.parse(data) });
            for (const w of waiters.splice(0)) w();
          }
        }
      }
    } catch {
      // aborted
    }
    resolveClosed();
    for (const w of waiters.splice(0)) w();
  })();
  return {
    events,
    closed,
    close: () => ctrl.abort(),
    waitFor(event, match = () => true, timeoutMs = 3000) {
      return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        let seen = 0;
        let settled = false;
        const check = () => {
          if (settled) return;
          for (; seen < events.length; seen++) {
            const e = events[seen]!;
            if (e.event === event && match(e.data)) {
              settled = true;
              return resolve(e.data);
            }
          }
          if (Date.now() > deadline) {
            settled = true;
            return reject(new Error(`timed out waiting for ${event}; saw ${events.map((e) => e.event).join(",")}`));
          }
          waiters.push(check);
          setTimeout(check, 100).unref();
        };
        check();
      });
    },
  };
}
