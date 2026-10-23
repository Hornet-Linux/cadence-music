/** Weather and time of day to a mood. Pure, so the mapping is easy to read and test. */

export type WeatherKind = "clear" | "partly" | "cloudy" | "fog" | "drizzle" | "rain" | "snow" | "storm";
export type TimeOfDay = "morning" | "afternoon" | "evening" | "night";
export type MoodId = "morning" | "afternoon" | "evening" | "night" | "sunny" | "cloudy" | "rainy" | "stormy" | "snowy" | "foggy";

export interface Mood {
  id: MoodId;
  label: string;
  blurb: string;
  /** 0 (very calm) to 1 (very energetic). */
  energy: number;
  /** Genre names that suit the mood; matched loosely against file tags. */
  genres: string[];
  /** Words that suit the mood; matched against song, album and artist names. */
  keywords: string[];
  /** Comfortable tempo range in beats per minute. */
  bpm: [number, number];
  /** Wording for the AI DJ. */
  prompt: string;
}

export const MOODS: Record<MoodId, Mood> = {
  morning: {
    id: "morning",
    label: "Gentle morning",
    blurb: "Soft and unhurried to ease into the day.",
    energy: 0.45,
    genres: ["acoustic", "folk", "indie", "singer-songwriter", "bossa nova", "jazz", "pop"],
    keywords: ["morning", "sun", "wake", "coffee", "sunrise", "good"],
    bpm: [70, 115],
    prompt: "a gentle, unhurried morning",
  },
  afternoon: {
    id: "afternoon",
    label: "Easy afternoon",
    blurb: "Steady and easy-going.",
    energy: 0.6,
    genres: ["indie", "pop", "rock", "funk", "soul", "reggae", "folk"],
    keywords: ["afternoon", "walk", "easy", "road", "summer", "light"],
    bpm: [85, 130],
    prompt: "an easy-going afternoon",
  },
  evening: {
    id: "evening",
    label: "Warm evening",
    blurb: "Mellow, warm and a little glowing.",
    energy: 0.5,
    genres: ["soul", "r&b", "jazz", "bossa nova", "funk", "lounge", "chillout", "disco"],
    keywords: ["evening", "sunset", "golden", "dusk", "night", "love", "slow"],
    bpm: [70, 115],
    prompt: "a warm, mellow evening",
  },
  night: {
    id: "night",
    label: "Quiet night",
    blurb: "Low and calm for the dark hours.",
    energy: 0.25,
    genres: ["ambient", "downtempo", "chillout", "lo-fi", "lofi", "piano", "classical", "jazz", "trip hop"],
    keywords: ["night", "moon", "midnight", "sleep", "dream", "stars", "quiet"],
    bpm: [50, 95],
    prompt: "a quiet, late night",
  },
  sunny: {
    id: "sunny",
    label: "Bright and sunny",
    blurb: "Upbeat and open, for a clear sky.",
    energy: 0.8,
    genres: ["pop", "indie pop", "funk", "reggae", "latin", "dance", "disco", "surf", "afrobeat"],
    keywords: ["sun", "summer", "sunshine", "happy", "bright", "dance", "day", "shine"],
    bpm: [100, 140],
    prompt: "a bright, sunny day",
  },
  cloudy: {
    id: "cloudy",
    label: "Soft grey",
    blurb: "Thoughtful and easy under a cloudy sky.",
    energy: 0.4,
    genres: ["indie", "alternative", "folk", "dream pop", "singer-songwriter", "acoustic", "post-rock"],
    keywords: ["grey", "gray", "cloud", "blue", "heavy", "slow", "still"],
    bpm: [70, 110],
    prompt: "an overcast, thoughtful day",
  },
  rainy: {
    id: "rainy",
    label: "Rainy and mellow",
    blurb: "Cosy and slow while it rains.",
    energy: 0.3,
    genres: ["jazz", "blues", "ambient", "lo-fi", "lofi", "acoustic", "piano", "classical", "trip hop", "downtempo"],
    keywords: ["rain", "blue", "tears", "grey", "umbrella", "storm", "mellow", "quiet"],
    bpm: [55, 100],
    prompt: "a cosy, mellow rainy day",
  },
  stormy: {
    id: "stormy",
    label: "Stormy",
    blurb: "Big and intense, to match the thunder.",
    energy: 0.85,
    genres: ["rock", "hard rock", "metal", "punk", "grunge", "industrial", "electronic", "drum and bass"],
    keywords: ["storm", "thunder", "lightning", "fire", "wild", "loud", "wind"],
    bpm: [110, 180],
    prompt: "a dramatic thunderstorm, big and intense",
  },
  snowy: {
    id: "snowy",
    label: "Snowy and cosy",
    blurb: "Warm and hushed for a cold day.",
    energy: 0.3,
    genres: ["classical", "ambient", "folk", "piano", "new age", "choral", "christmas", "acoustic"],
    keywords: ["snow", "winter", "cold", "white", "frost", "ice", "fireside", "christmas"],
    bpm: [50, 100],
    prompt: "a cosy, snowy winter day",
  },
  foggy: {
    id: "foggy",
    label: "Misty and dreamy",
    blurb: "Hazy, slow and a little unreal.",
    energy: 0.3,
    genres: ["ambient", "shoegaze", "dream pop", "post-rock", "downtempo", "electronic", "chillout"],
    keywords: ["fog", "mist", "haze", "dream", "cloud", "float", "drift"],
    bpm: [60, 105],
    prompt: "a misty, dreamy day",
  },
};

/** Group a WMO weather code (as used by Open-Meteo) into a few kinds. */
export function classifyWeather(code: number): { kind: WeatherKind; label: string } {
  if (code === 0) return { kind: "clear", label: "Clear sky" };
  if (code === 1) return { kind: "clear", label: "Mostly clear" };
  if (code === 2) return { kind: "partly", label: "Partly cloudy" };
  if (code === 3) return { kind: "cloudy", label: "Overcast" };
  if (code === 45 || code === 48) return { kind: "fog", label: "Fog" };
  if (code >= 51 && code <= 57) return { kind: "drizzle", label: "Drizzle" };
  if (code >= 61 && code <= 67) return { kind: "rain", label: code >= 65 ? "Heavy rain" : "Rain" };
  if (code >= 71 && code <= 77) return { kind: "snow", label: "Snow" };
  if (code >= 80 && code <= 82) return { kind: "rain", label: "Rain showers" };
  if (code === 85 || code === 86) return { kind: "snow", label: "Snow showers" };
  if (code >= 95 && code <= 99) return { kind: "storm", label: "Thunderstorm" };
  return { kind: "cloudy", label: "Unsettled" };
}

export function timeOfDay(hour: number): TimeOfDay {
  if (hour >= 22 || hour < 5) return "night";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

export interface WeatherNow {
  code: number;
  tempC: number | null;
  isDay: boolean;
  /** Local hour at the place, 0-23. */
  hour: number;
}

/**
 * Pick a mood. Severe weather wins, then rain, fog and dark hours; on an ordinary day the time of
 * day and sky decide, with very cold and very hot days nudging toward cosy and bright.
 */
export function moodFor(w: WeatherNow): Mood {
  const { kind } = classifyWeather(w.code);
  if (kind === "storm") return MOODS.stormy;
  if (kind === "snow") return MOODS.snowy;
  if (kind === "rain" || kind === "drizzle") return MOODS.rainy;
  if (kind === "fog") return MOODS.foggy;
  const part = timeOfDay(w.hour);
  if (!w.isDay || part === "night") return MOODS.night;
  if (w.tempC !== null && w.tempC <= -2) return MOODS.snowy;
  if (kind === "cloudy") return MOODS.cloudy;
  if (w.tempC !== null && w.tempC >= 30) return MOODS.sunny;
  if (part === "morning") return MOODS.morning;
  if (part === "afternoon") return MOODS.sunny;
  return MOODS.evening;
}

/** Without weather, the time of day alone. */
export function moodForTime(hour: number): Mood {
  return MOODS[timeOfDay(hour)];
}

// ---- Open-Meteo ------------------------------------------------------------------------------

export const FORECAST_HOST = "api.open-meteo.com";

/** Latitude and longitude are rounded to two decimals (about a kilometre) before they leave the device. */
export function roundCoord(n: number): number {
  return Math.round(n * 100) / 100;
}

export function validCoords(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/** The only request this plugin makes about weather. It carries coordinates and nothing else. */
export function forecastUrl(lat: number, lon: number): string {
  if (!validCoords(lat, lon)) throw new Error("Those coordinates aren't valid.");
  const params = new URLSearchParams({
    latitude: String(roundCoord(lat)),
    longitude: String(roundCoord(lon)),
    current: "temperature_2m,weather_code,is_day",
    timezone: "auto",
  });
  return `https://${FORECAST_HOST}/v1/forecast?${params}`;
}

export interface Forecast extends WeatherNow {
  label: string;
}

/** Read an Open-Meteo "current" answer; null when it is not shaped as expected. */
export function parseForecast(json: unknown): Forecast | null {
  const current = (json as { current?: Record<string, unknown> } | null)?.current;
  if (!current || typeof current.weather_code !== "number") return null;
  const time = typeof current.time === "string" ? /T(\d{2}):/.exec(current.time) : null;
  const hour = time ? Number(time[1]) : new Date().getHours();
  const tempC = typeof current.temperature_2m === "number" && Number.isFinite(current.temperature_2m) ? current.temperature_2m : null;
  return {
    code: current.weather_code,
    tempC,
    isDay: current.is_day === 1 || current.is_day === true,
    hour: Number.isInteger(hour) && hour >= 0 && hour < 24 ? hour : new Date().getHours(),
    label: classifyWeather(current.weather_code).label,
  };
}