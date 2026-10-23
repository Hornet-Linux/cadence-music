import { describe, expect, it } from "vitest";
import { readSse } from "./sse";
import type { SseMessage } from "./types";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
}

async function collect(chunks: string[]): Promise<SseMessage[]> {
  const out: SseMessage[] = [];
  await readSse(streamOf(chunks), (m) => out.push(m));
  return out;
}

describe("readSse", () => {
  it("parses events split across chunks and ignores keep-alive comments", async () => {
    const out = await collect(['retry: 3000\n\nevent: hello\ndata: {"a"', ":1}\n\n: keep-alive\n\nevent: state\ndata: {\"b\":2}\n\n"]);
    expect(out).toEqual([
      { event: "hello", data: { a: 1 } },
      { event: "state", data: { b: 2 } },
    ]);
  });

  it("handles CRLF line endings and the default event name", async () => {
    expect(await collect(['data: {"x":true}\r\n\r\n'])).toEqual([{ event: "message", data: { x: true } }]);
  });

  it("skips malformed JSON and carries on", async () => {
    const out = await collect(["event: bad\ndata: {nope\n\n", 'event: ok\ndata: {"n":1}\n\n']);
    expect(out).toEqual([{ event: "ok", data: { n: 1 } }]);
  });

  it("reports activity for every chunk so a watchdog can be reset", async () => {
    let n = 0;
    await readSse(streamOf([": a\n\n", ": b\n\n"]), () => undefined, () => n++);
    expect(n).toBe(2);
  });
});
