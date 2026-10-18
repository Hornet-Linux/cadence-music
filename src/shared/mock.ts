import type { Playlist, Track } from "./types";

// Placeholder library content so the UI is populated during early development.
// Real content will arrive from source/library plugins.

export const mockTracks: Track[] = [
  { id: "t1", title: "Neon Harbor", artists: [{ id: "a1", name: "Vela Nine" }], album: "Afterglow", durationSec: 213, source: "demo" },
  { id: "t2", title: "Paper Satellites", artists: [{ id: "a2", name: "Mono Atlas" }], album: "Low Orbit", durationSec: 187, source: "demo" },
  { id: "t3", title: "Cassette Sunrise", artists: [{ id: "a3", name: "The Hour Hand" }], album: "Daylight Savings", durationSec: 241, source: "demo" },
  { id: "t4", title: "Glass Avenue", artists: [{ id: "a1", name: "Vela Nine" }], album: "Afterglow", durationSec: 198, source: "demo" },
  { id: "t5", title: "Undertow", artists: [{ id: "a4", name: "Kaskade Reef" }], album: "Tidal", durationSec: 302, source: "demo" },
  { id: "t6", title: "Midnight Transit", artists: [{ id: "a2", name: "Mono Atlas" }], album: "Low Orbit", durationSec: 176, source: "demo" },
  { id: "t7", title: "Velvet Static", artists: [{ id: "a5", name: "Room 214" }], album: "Hotel Tapes", durationSec: 229, source: "demo" },
  { id: "t8", title: "Golden Hour", artists: [{ id: "a3", name: "The Hour Hand" }], album: "Daylight Savings", durationSec: 254, source: "demo" },
];

export const mockPlaylists: Playlist[] = [
  { id: "p1", name: "Late Night Drive", trackCount: 42 },
  { id: "p2", name: "Focus Flow", trackCount: 28 },
  { id: "p3", name: "Sunday Coffee", trackCount: 61 },
  { id: "p4", name: "Workout Heat", trackCount: 35 },
  { id: "p5", name: "Rainy Window", trackCount: 19 },
];

export const recentlyPlayed = mockTracks.slice(0, 6);
export const madeForYou = mockTracks.slice(2, 8);
