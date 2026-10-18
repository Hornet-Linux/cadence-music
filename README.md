# unnamed_music_app

A desktop music player that you own end to end. Run it entirely on your own
computer, or self-host the server part on a VPS with Docker and point the desktop
app at it. **Plugin-first**: the app is a clean player shell, and almost
everything else — where audio comes from, lyrics, scrobbling, service
connections — is a plugin.

## Goals

- **Desktop app**: a Windows installer (`.exe`) that works on its own, locally.
- **Self-hostable server**: optional backend shipped as Docker containers, so your
  library, playlists and history live on hardware you control.
- **Bring your music in**: connect or import from Spotify and Apple Music.
- **Plugins**: extend the app with plugins at well-defined contribution points.

## Stack

Electron 31 · React 18 · TypeScript · Vite · Zustand. No heavyweight UI
framework — a hand-rolled CSS design system (dark, modern player aesthetic).

## Development

Requires **Node.js 20+**.

```bash
npm install
npm run dev        # launch the Electron app with hot reload
npm run build      # typecheck + production build
npm run electron:build:win   # package a Windows .exe (nsis)
```

## Project layout

```
electron/   Electron main + preload (the Node side)
src/
  app/        App root, routing, global CSS
  ui/         shell + reusable components
  features/   home / search / library / settings views
  player/     playback engine over a single <audio> element
  plugins/    plugin contracts, host/registry, built-in + sample plugins
  shared/     shared types + placeholder library data
docs/         ARCHITECTURE.md, PLUGINS.md
```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the app is put together.
- [docs/PLUGINS.md](docs/PLUGINS.md) — the plugin model, capabilities and
  contribution points.

## Status

Early development. This is the foundation: a working, good-looking player shell
and the plugin system, with built-in sample plugins demonstrating each
contribution point. Real source/service plugins, lyrics, and the self-hosted
Docker server come next.
