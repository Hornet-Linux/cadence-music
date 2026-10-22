import type { SseMessage } from "./types";

/**
 * Reads a server-sent-events body. EventSource cannot send an Authorization header, so the relay is read from a
 * plain fetch stream instead. Calls `onMessage` for each event and resolves when the stream ends.
 */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onMessage: (m: SseMessage) => void,
  onActivity: () => void = () => undefined,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    onActivity();
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue; // keep-alive comment
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length === 0) continue;
      try {
        onMessage({ event, data: JSON.parse(data.join("\n")) });
      } catch {
        // A malformed event is skipped; the stream carries on.
      }
    }
  }
}
