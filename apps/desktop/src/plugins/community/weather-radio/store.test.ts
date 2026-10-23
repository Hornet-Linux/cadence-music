import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@/plugins/types";
import { attach, keywordList, useRadio } from "./store";

function memoryStorage(initial: Record<string, unknown> = {}): PluginStorage & { data: Record<string, unknown> } {
  const data = { ...initial };
  return {
    data,
    get: <T,>(key: string) => (key in data ? (data[key] as T) : null),
    set: (key, value) => void (data[key] = value),
    remove: (key) => void delete data[key],
  };
}

const answer = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response;

function reset() {
  useRadio.setState({ mode: "off", lat: undefined, lon: undefined, useAi: false, keywords: {}, loaded: false, weather: null, fetchedAt: 0, status: "idle", error: null, station: null });
}

describe("weather radio settings and privacy", () => {
  beforeEach(reset);

  it("starts with nothing chosen and sends nothing", () => {
    const fetchMock = vi.fn();
    attach({ fetch: fetchMock as unknown as typeof fetch, storage: memoryStorage(), play: async () => undefined });
    useRadio.getState().load();
    expect(useRadio.getState().mode).toBe("off");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("time-of-day mode never touches the network", async () => {
    const fetchMock = vi.fn();
    attach({ fetch: fetchMock as unknown as typeof fetch, storage: memoryStorage(), play: async () => undefined });
    useRadio.getState().load();
    useRadio.getState().setMode("time");
    await useRadio.getState().refreshWeather(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useRadio.getState().currentMood()).not.toBeNull();
  });

  it("asks Open-Meteo for the forecast with rounded coordinates only, and keeps them on the device", async () => {
    const fetchMock = vi.fn(async () => answer({ current: { time: "2026-10-22T09:00", temperature_2m: 8, weather_code: 61, is_day: 1 } }));
    const storage = memoryStorage();
    attach({ fetch: fetchMock as unknown as typeof fetch, storage, play: async () => undefined });
    useRadio.getState().load();
    expect(useRadio.getState().setLocation(52.52008, 13.40495)).toBe(true);
    await vi.waitFor(() => expect(useRadio.getState().weather).not.toBeNull());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.hostname).toBe("api.open-meteo.com");
    expect(parsed.searchParams.get("latitude")).toBe("52.52");
    expect(parsed.searchParams.get("longitude")).toBe("13.4");
    expect(init.credentials).toBe("omit");
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(useRadio.getState().currentMood()?.id).toBe("rainy");
    // The place is saved only in this plugin's local storage.
    expect(storage.data.settings).toMatchObject({ mode: "weather", lat: 52.52, lon: 13.4 });
  });

  it("falls back to the time of day when the weather service fails", async () => {
    attach({ fetch: (async () => answer({}, false)) as unknown as typeof fetch, storage: memoryStorage(), play: async () => undefined });
    useRadio.getState().load();
    useRadio.getState().setLocation(10, 10);
    await vi.waitFor(() => expect(useRadio.getState().status).toBe("error"));
    expect(useRadio.getState().error).toMatch(/time of day/);
    expect(useRadio.getState().currentMood()).not.toBeNull();
  });

  it("refuses impossible coordinates without calling out", () => {
    const fetchMock = vi.fn();
    attach({ fetch: fetchMock as unknown as typeof fetch, storage: memoryStorage(), play: async () => undefined });
    useRadio.getState().load();
    expect(useRadio.getState().setLocation(200, 0)).toBe(false);
    expect(useRadio.getState().mode).toBe("off");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("restores saved settings, and forgetting the place removes it", () => {
    const storage = memoryStorage({ settings: { mode: "weather", lat: 1.5, lon: 2.5, useAi: true, keywords: { rainy: "cafe" } } });
    attach({ fetch: vi.fn() as unknown as typeof fetch, storage, play: async () => undefined });
    useRadio.getState().load();
    expect(useRadio.getState()).toMatchObject({ mode: "weather", lat: 1.5, lon: 2.5, useAi: true });
    useRadio.getState().forgetLocation();
    expect(useRadio.getState()).toMatchObject({ mode: "off", lat: undefined, lon: undefined });
    expect(storage.data.settings).toMatchObject({ mode: "off" });
    expect((storage.data.settings as { lat?: number }).lat).toBeUndefined();
  });

  it("ignores a saved weather mode that has no valid place", () => {
    attach({ fetch: vi.fn() as unknown as typeof fetch, storage: memoryStorage({ settings: { mode: "weather", lat: 999, lon: 0 } }), play: async () => undefined });
    useRadio.getState().load();
    expect(useRadio.getState().mode).toBe("off");
  });
});

describe("keywordList", () => {
  it("splits on commas and newlines and drops blanks", () => {
    expect(keywordList(" cafe, acoustic\n\nrain ,")).toEqual(["cafe", "acoustic", "rain"]);
    expect(keywordList(undefined)).toEqual([]);
  });
});