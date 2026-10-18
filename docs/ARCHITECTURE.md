# Architecture

Unnamed Music App is a **plugin-first** desktop music player. The app is a thin,
good-looking shell — library, playback, navigation — and almost every capability
beyond that (where audio comes from, lyrics, scrobbling, service connections) is
provided by **plugins**.

## Two parts

1. **Desktop app** (this repo): an Electron + React + TypeScript application that
   runs standalone on your computer and ships as a Windows `.exe`.
2. **Self-hosted server** (planned, separate deployment): optional backend shipped
   as Docker containers so your library, playlists and history can live on a VPS
   you control. The desktop app points at your instance; nothing is required to
   use the app locally.

## Desktop stack

| Concern        | Choice                                  |
| -------------- | --------------------------------------- |
| Shell          | Electron 31 (frameless, custom titlebar) |
| UI             | React 18 + TypeScript, hand-rolled CSS design system |
| State          | Zustand stores (`player`, `pluginHost`, `nav`) |
| Build          | Vite + `vite-plugin-electron`           |

### Process model

- **Main process** (`electron/main.ts`): owns the window and window controls.
  External links always open in the user's real browser, never in-app.
- **Preload** (`electron/preload.ts`): exposes a deliberately tiny, explicit
  bridge (`window.host`) via `contextBridge`. `nodeIntegration` is off and
  `contextIsolation` is on.
- **Renderer** (`src/`): the whole UI and the plugin host.

### Source layout

```
electron/        main + preload (Node side)
src/
  app/           App root, routing (navStore), global CSS
  ui/            shell + reusable components (TitleBar, Sidebar, PlayerBar, cards, icons)
  features/      home / search / library / settings views
  player/        playback engine (playerStore) over a single <audio> element
  plugins/       plugin contracts (types.ts), host/registry (host.ts), built-ins
  shared/        shared types + mock library data
```

## Playback

`player/playerStore.ts` drives a single shared `HTMLAudioElement`: queue,
play/pause, next/previous, seek, volume, shuffle and repeat. To play a track it
asks the plugin host to **resolve** it to a playable URL. With no source plugin
enabled, the player shows an honest "no source can play this yet" state rather
than faking audio.

## Plugin system

See [PLUGINS.md](./PLUGINS.md). In short: a plugin declares a **manifest** with
the **capabilities** it needs; the host grants them on user consent and hands the
plugin a **context** whose surface is limited to what it was granted. Plugins
contribute sidebar pages, Home widgets, settings panels, audio sources, library
sources, and now-playing observers.

## Roadmap (high level)

- v1: the shell + plugin system (this). Built-in sample plugins demonstrate each
  contribution point.
- Next: real source plugins (local files, then service connectors), lyrics,
  the self-hosted Docker server, and signed third-party plugin packages.
