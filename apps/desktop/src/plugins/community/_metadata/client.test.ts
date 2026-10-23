import { describe, expect, it, vi } from "vitest";
import { createMetadataClient, mapLimit, MetadataError } from "./client";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setup(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, server: { url: string; token: string | null } | null = { url: "https://cadence.test", token: "tok" }) {
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  let t = 1_000_000;
  const client = createMetadataClient({ fetch: fetchFn as unknown as typeof fetch, server: () => server, now: () => t });
  return { client, fetchFn, advance: (ms: number) => (t += ms) };
}

describe("metadata client", () => {
  it("calls the server with the bearer token and the query", async () => {
    const { client, fetchFn } = setup(() => json({ mbid: "m", name: "Radiohead", genres: [], links: [] }));
    const artist = await client.artist("Radiohead");
    expect(artist.name).toBe("Radiohead");
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toBe("https://cadence.test/api/metadata/musicbrainz/artist?name=Radiohead");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("encodes odd artist names and leaves out empty params", async () => {
    const { client, fetchFn } = setup(() => json({ items: [] }));
    await client.events("AC/DC & Co", "Zürich", undefined);
    const url = new URL(String(fetchFn.mock.calls[0][0]));
    expect(url.searchParams.get("name")).toBe("AC/DC & Co");
    expect(url.searchParams.get("city")).toBe("Zürich");
    expect(url.searchParams.has("country")).toBe(false);
  });

  it("answers repeats from memory and shares requests in flight", async () => {
    const { client, fetchFn } = setup(() => json({ title: "x", extract: "y" }));
    await Promise.all([client.wikipedia("A"), client.wikipedia("A")]);
    await client.wikipedia("A");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("asks again after ten minutes", async () => {
    const { client, fetchFn, advance } = setup(() => json({ title: "x", extract: "y" }));
    await client.wikipedia("A");
    advance(11 * 60_000);
    await client.wikipedia("A");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("maps server errors to kinds", async () => {
    const cases: [number, object, string][] = [
      [404, { error: "not_found" }, "not_found"],
      [501, { error: "not_configured", message: "needs a key", provider: "Bandsintown" }, "not_configured"],
      [503, { error: "busy" }, "busy"],
      [502, { error: "upstream_failed", message: "down" }, "failed"],
      [401, { error: "unauthorized" }, "no_server"],
    ];
    for (const [status, body, kind] of cases) {
      const { client } = setup(() => json(body, status));
      await expect(client.artist("X")).rejects.toMatchObject({ kind });
    }
  });

  it("carries the server message and provider on not_configured", async () => {
    const { client } = setup(() => json({ error: "not_configured", message: "Bandsintown needs a key.", provider: "Bandsintown" }, 501));
    await expect(client.events("A", "Paris")).rejects.toMatchObject({ message: "Bandsintown needs a key.", provider: "Bandsintown" });
  });

  it("does not remember failures that may pass, but remembers a missing key for a minute", async () => {
    let status = 502;
    const { client, fetchFn, advance } = setup(() => (status === 200 ? json({ ok: 1 }) : json({}, status)));
    await expect(client.status()).rejects.toBeInstanceOf(MetadataError);
    status = 200;
    await expect(client.status()).resolves.toEqual({ ok: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const missing = setup(() => json({ error: "not_configured" }, 501));
    await expect(missing.client.fanart("A")).rejects.toMatchObject({ kind: "not_configured" });
    await expect(missing.client.fanart("A")).rejects.toMatchObject({ kind: "not_configured" });
    expect(missing.fetchFn).toHaveBeenCalledTimes(1);
    missing.advance(61_000);
    await expect(missing.client.fanart("A")).rejects.toMatchObject({ kind: "not_configured" });
    expect(missing.fetchFn).toHaveBeenCalledTimes(2);
    advance(0);
  });

  it("says no_server without a server and never calls the network", async () => {
    const { client, fetchFn } = setup(() => json({}), null);
    await expect(client.artist("A")).rejects.toMatchObject({ kind: "no_server" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("treats a network failure as failed", async () => {
    const { client } = setup(() => {
      throw new TypeError("offline");
    });
    await expect(client.artist("A")).rejects.toMatchObject({ kind: "failed" });
  });

  it("lets a caller abort without cancelling the shared request", async () => {
    const { client, fetchFn } = setup(() => json({ title: "t", extract: "e" }));
    const controller = new AbortController();
    const waiting = client.wikipedia("A", controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await expect(client.wikipedia("A")).resolves.toMatchObject({ title: "t" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("mapLimit", () => {
  it("keeps order, limits concurrency and turns failures into null", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      if (n === 3) throw new Error("boom");
      return n * 10;
    });
    expect(out).toEqual([10, 20, null, 40, 50]);
    expect(peak).toBe(2);
  });

  it("stops starting work when asked", async () => {
    let started = 0;
    await mapLimit([1, 2, 3, 4], 1, async () => void started++, () => started >= 2);
    expect(started).toBe(2);
  });
});
