import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, endsCadenceSession, useServer } from "./serverStore";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  useServer.setState({ url: "https://cadence.example", token: "tok", user: { id: "u", username: "ann" } as never });
});
afterEach(() => vi.unstubAllGlobals());

describe("server api", () => {
  it("signs out of Cadence when the session is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(401, { error: "unauthorized" })));
    await expect(useServer.getState().api("api/me")).rejects.toThrow(/session expired/i);
    expect(useServer.getState()).toMatchObject({ token: null, user: null });
  });

  it("keeps the Cadence session when only the Jellyfin session expired", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(401, { error: "jellyfin_session_expired" })));
    const err = await useServer.getState().api("api/jellyfin/tracks").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, code: "jellyfin_session_expired" });
    expect(useServer.getState().token).toBe("tok");
    expect(useServer.getState().user).not.toBeNull();
  });

  it("keeps the Cadence session when Jellyfin rejects the password", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(401, { error: "invalid_credentials" })));
    await expect(useServer.getState().api("api/jellyfin/connection", { method: "PUT", body: "{}" })).rejects.toMatchObject({
      status: 401,
    });
    expect(useServer.getState().token).toBe("tok");
  });

  it("still signs out when a Jellyfin route answers with the server's own 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(401, { error: "unauthorized" })));
    await expect(useServer.getState().api("api/jellyfin/tracks")).rejects.toThrow(/session expired/i);
    expect(useServer.getState().token).toBeNull();
  });

  it("reports failures with their status and code, with the same message as before", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(502, { error: "jellyfin_unreachable" })));
    const err = (await useServer.getState().api("api/jellyfin/status").catch((e: unknown) => e)) as ApiError;
    expect(err.message).toBe("Request failed (502): jellyfin unreachable");
    expect(err).toMatchObject({ status: 502, code: "jellyfin_unreachable" });
  });
});

describe("which 401s end the Cadence session", () => {
  it("signs out only on the server's own answer, never on a source plugin's 401", async () => {
    expect(await endsCadenceSession("api/library", json(401, { error: "unauthorized" }))).toBe(true);
    expect(await endsCadenceSession("api/library", new Response("no", { status: 401 }))).toBe(true);
    expect(await endsCadenceSession("api/audiobooks/connection", json(401, { error: "audiobooks_invalid_credentials" }))).toBe(false);
    expect(await endsCadenceSession("api/audiobooks/status", json(401, { error: "audiobooks_session_expired" }))).toBe(false);
    expect(await endsCadenceSession("api/jellyfin/items", new Response("no", { status: 401 }))).toBe(false);
    expect(await endsCadenceSession("api/jellyfin/items", json(401, { error: "unauthorized" }))).toBe(true);
    expect(await endsCadenceSession("api/library", json(403, { error: "forbidden" }))).toBe(false);
  });

  it("keeps the person signed in when Audiobookshelf refuses a password", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(401, { error: "audiobooks_invalid_credentials", message: "nope" })));
    await expect(useServer.getState().api("api/audiobooks/connection", { method: "PUT", body: "{}" })).rejects.toBeInstanceOf(ApiError);
    expect(useServer.getState().token).toBe("tok");
  });
});
