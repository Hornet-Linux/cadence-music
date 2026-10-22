import { describe, expect, it } from "vitest";
import { classifyWeather, FORECAST_HOST, forecastUrl, MOODS, moodFor, moodForTime, parseForecast, roundCoord, timeOfDay, validCoords } from "./mood";

const day = (code: number, hour: number, tempC: number | null = 15) => moodFor({ code, tempC, isDay: true, hour }).id;

describe("weather codes", () => {
  it("groups Open-Meteo codes into kinds", () => {
    expect(classifyWeather(0).kind).toBe("clear");
    expect(classifyWeather(2).kind).toBe("partly");
    expect(classifyWeather(3).kind).toBe("cloudy");
    expect(classifyWeather(45).kind).toBe("fog");
    expect(classifyWeather(53).kind).toBe("drizzle");
    expect(classifyWeather(63).kind).toBe("rain");
    expect(classifyWeather(81).kind).toBe("rain");
    expect(classifyWeather(73).kind).toBe("snow");
    expect(classifyWeather(86).kind).toBe("snow");
    expect(classifyWeather(95).kind).toBe("storm");
    expect(classifyWeather(1234).kind).toBe("cloudy");
  });
  it("tells morning, afternoon, evening and night apart", () => {
    expect([4, 5, 11, 12, 16, 17, 21, 22].map(timeOfDay)).toEqual(["night", "morning", "morning", "afternoon", "afternoon", "evening", "evening", "night"]);
  });
});

describe("weather to mood", () => {
  it("lets severe weather decide first", () => {
    expect(day(95, 14)).toBe("stormy");
    expect(day(73, 9)).toBe("snowy");
    expect(day(61, 14)).toBe("rainy");
    expect(day(51, 8)).toBe("rainy");
    expect(day(45, 14)).toBe("foggy");
  });
  it("uses the time of day on an ordinary day", () => {
    expect(day(0, 8)).toBe("morning");
    expect(day(1, 14)).toBe("sunny");
    expect(day(2, 19)).toBe("evening");
    expect(day(3, 14)).toBe("cloudy");
  });
  it("goes quiet at night, whatever the sky, but not in a storm", () => {
    expect(moodFor({ code: 0, tempC: 10, isDay: false, hour: 23 }).id).toBe("night");
    expect(moodFor({ code: 3, tempC: 10, isDay: false, hour: 2 }).id).toBe("night");
    expect(moodFor({ code: 95, tempC: 10, isDay: false, hour: 2 }).id).toBe("stormy");
  });
  it("lets heat and frost nudge the mood", () => {
    expect(day(0, 9, 31)).toBe("sunny");
    expect(day(0, 9, -5)).toBe("snowy");
    expect(day(0, 9, null)).toBe("morning");
  });
  it("falls back to the time of day when there is no weather", () => {
    expect(moodForTime(8).id).toBe("morning");
    expect(moodForTime(23).id).toBe("night");
  });
  it("describes every mood sensibly", () => {
    for (const m of Object.values(MOODS)) {
      expect(m.genres.length).toBeGreaterThan(3);
      expect(m.energy).toBeGreaterThanOrEqual(0);
      expect(m.energy).toBeLessThanOrEqual(1);
      expect(m.bpm[0]).toBeLessThan(m.bpm[1]);
    }
    expect(MOODS.stormy.energy).toBeGreaterThan(MOODS.rainy.energy);
    expect(MOODS.night.energy).toBeLessThan(MOODS.sunny.energy);
  });
});

describe("what leaves the device", () => {
  it("builds one request to Open-Meteo that carries only rounded coordinates", () => {
    const url = new URL(forecastUrl(52.52008, 13.40495));
    expect(url.hostname).toBe(FORECAST_HOST);
    expect(url.protocol).toBe("https:");
    expect([...url.searchParams.keys()].sort()).toEqual(["current", "latitude", "longitude", "timezone"]);
    expect(url.searchParams.get("latitude")).toBe("52.52");
    expect(url.searchParams.get("longitude")).toBe("13.4");
  });
  it("refuses impossible coordinates", () => {
    expect(() => forecastUrl(95, 0)).toThrow();
    expect(() => forecastUrl(0, NaN)).toThrow();
    expect(validCoords(-33.87, 151.21)).toBe(true);
    expect(roundCoord(1.005)).toBeCloseTo(1, 1);
  });
});

describe("parseForecast", () => {
  it("reads a normal answer", () => {
    expect(parseForecast({ current: { time: "2026-10-22T17:15", temperature_2m: 11.4, weather_code: 61, is_day: 1 } })).toEqual({
      code: 61,
      tempC: 11.4,
      isDay: true,
      hour: 17,
      label: "Rain",
    });
  });
  it("copes with missing parts and rejects junk", () => {
    const sparse = parseForecast({ current: { weather_code: 0, is_day: 0 } });
    expect(sparse).toMatchObject({ code: 0, tempC: null, isDay: false });
    expect(parseForecast({})).toBeNull();
    expect(parseForecast(null)).toBeNull();
    expect(parseForecast({ current: { weather_code: "rain" } })).toBeNull();
  });
});