/** GET/POST helper for talking to devices on the local network: short timeout, capped body size. */
export async function fetchText(
  url: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ status: number; ok: boolean; text: string; headers: Headers }> {
  const maxBytes = opts.maxBytes ?? 1024 * 1024;
  const res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? 5000) });
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("response too large");
      }
      chunks.push(value);
    }
  }
  return { status: res.status, ok: res.ok, text: Buffer.concat(chunks).toString("utf8"), headers: res.headers };
}
