# Cadence

[![CI](https://github.com/Hornet-Linux/cadence-music/actions/workflows/ci.yml/badge.svg)](https://github.com/Hornet-Linux/cadence-music/actions/workflows/ci.yml)

A music player you own end to end: apps for your computer, your browser and
your phone, backed by a small server you host yourself. Your own music files,
Spotify and Apple Music show up in one library and play in one queue, and your
liked songs, playlists and listening history follow you to every device.
**Plugin-first** — the app is a clean player shell, and almost everything else
(where music comes from, sign-in, service connections) is a plugin, on both the
apps and the server.

**New here? The [wiki](https://github.com/Hornet-Linux/cadence-music/wiki) has
step-by-step guides written for beginners, starting with
[Getting Started](https://github.com/Hornet-Linux/cadence-music/wiki/Getting-Started).**

## What's here

- **Self-hosted server** (`apps/server`) — one Docker container. Accounts,
  single sign-on, listening history, liked songs and playlists, and an optional
  music-file library streamed with seeking. Also serves the web player, the
  landing page and the admin panel.
- **Web player** — the full app in any browser at `https://your-domain/app`.
- **Desktop app** (`apps/desktop`) — Electron, ships for Windows (`.exe`) and
  macOS (`.dmg`). Plays local files on its own, or connects to your server.
- **iOS app** (`apps/ios`) — sideloaded with a free Apple ID; plays from your
  server in the background with lock-screen controls.
- **Single sign-on** — OIDC with any provider (Authentik, Keycloak, …) plus an
  optional local admin account.
- **Spotify and Apple Music** — official sign-in, your library in the app, and
  full in-app playback (Premium / subscription), mixed in one queue with your
  own music.
- **Plugins** — capability-based plugins on the desktop, and the same plugin
  seam on the server.

## Quick start

**1. Run the server** on any Linux VPS, after pointing a domain's DNS at it:

```bash
curl -fsSL https://raw.githubusercontent.com/Hornet-Linux/cadence-music/main/deploy/install.sh | bash
```

That installs Docker if needed, asks a few questions (Enter accepts the
defaults), sets up HTTPS and prints a one-time setup code. Every question is
explained in the wiki's
[Self-Hosting](https://github.com/Hornet-Linux/cadence-music/wiki/Self-Hosting) page.

**2. Claim it:** open `https://your-domain/app`, enter the setup code and choose
your admin login. Manage people at `https://your-domain/admin`.

**3. Listen** in the browser at `/app`, or install an app:

- **Windows:** [Cadence-Setup.exe](https://github.com/Hornet-Linux/cadence-music/releases/latest/download/Cadence-Setup.exe)
- **macOS (Apple Silicon):** [Cadence-mac-arm64.dmg](https://github.com/Hornet-Linux/cadence-music/releases/latest/download/Cadence-mac-arm64.dmg)
- **macOS (Intel):** [Cadence-mac-x64.dmg](https://github.com/Hornet-Linux/cadence-music/releases/latest/download/Cadence-mac-x64.dmg)
- **iPhone / iPad:** [Cadence.ipa](https://github.com/Hornet-Linux/cadence-music/releases/latest/download/Cadence.ipa), sideloaded with a free Apple ID ([how](https://github.com/Hornet-Linux/cadence-music/wiki/iOS-App))

The Mac app isn't notarized by Apple, so the first time, open it with
right-click → **Open** (or System Settings → Privacy & Security → **Open Anyway**).

To update the server later, run the same command again.

**4. Connect services:** [Spotify](https://github.com/Hornet-Linux/cadence-music/wiki/Spotify)
(free developer app, Premium for playback) and
[Apple Music](https://github.com/Hornet-Linux/cadence-music/wiki/Apple-Music)
(needs a MusicKit key on the server).

## Documentation

The **[wiki](https://github.com/Hornet-Linux/cadence-music/wiki)** is the
user guide, written for beginners:

| | |
| --- | --- |
| Start | [Getting Started](https://github.com/Hornet-Linux/cadence-music/wiki/Getting-Started) · [Self-Hosting](https://github.com/Hornet-Linux/cadence-music/wiki/Self-Hosting) · [Configuration](https://github.com/Hornet-Linux/cadence-music/wiki/Configuration) |
| Using Cadence | [Web Player](https://github.com/Hornet-Linux/cadence-music/wiki/Web-Player) · [Desktop App](https://github.com/Hornet-Linux/cadence-music/wiki/Desktop-App) · [iOS App](https://github.com/Hornet-Linux/cadence-music/wiki/iOS-App) · [Library and Playback](https://github.com/Hornet-Linux/cadence-music/wiki/Library-and-Playback) · [Liked Songs and Playlists](https://github.com/Hornet-Linux/cadence-music/wiki/Liked-Songs-and-Playlists) · [Listening History](https://github.com/Hornet-Linux/cadence-music/wiki/Listening-History) |
| People | [Accounts and Sign-in](https://github.com/Hornet-Linux/cadence-music/wiki/Accounts-and-Sign-in) · [Single Sign-On (OIDC)](https://github.com/Hornet-Linux/cadence-music/wiki/Single-Sign-On-OIDC) · [Admin Panel](https://github.com/Hornet-Linux/cadence-music/wiki/Admin-Panel) |
| Services | [Spotify](https://github.com/Hornet-Linux/cadence-music/wiki/Spotify) · [Apple Music](https://github.com/Hornet-Linux/cadence-music/wiki/Apple-Music) |
| Under the hood | [Architecture](https://github.com/Hornet-Linux/cadence-music/wiki/Architecture) · [Plugins](https://github.com/Hornet-Linux/cadence-music/wiki/Plugins) · [Server API](https://github.com/Hornet-Linux/cadence-music/wiki/Server-API) · [Security](https://github.com/Hornet-Linux/cadence-music/wiki/Security) · [iOS App with Xcode](https://github.com/Hornet-Linux/cadence-music/wiki/iOS-App-with-Xcode) |
| Help | [Troubleshooting](https://github.com/Hornet-Linux/cadence-music/wiki/Troubleshooting) · [Known Issues](https://github.com/Hornet-Linux/cadence-music/wiki/Known-Issues) · [Development](https://github.com/Hornet-Linux/cadence-music/wiki/Development) |

Reference docs kept next to the code:

- [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) — deploy the server, Caddy,
  Authentik/OIDC setup, configuration reference.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how it fits together.
- [docs/PLUGINS.md](docs/PLUGINS.md) — desktop and server plugins.
- [docs/IOS.md](docs/IOS.md) — the iOS app.

## Development

Requires **Node.js 22+**. Each app installs on its own:

```bash
cd apps/desktop
npm install
npm run dev          # Electron app with hot reload
npm run dev:web      # the web player in a browser
npm run lint && npm run typecheck && npm test

cd ../server
npm install
npm test             # compiles, then runs node:test
npm run build
MUSIC_DIR=~/Music ADMIN_USERNAME=admin ADMIN_PASSWORD=adminadmin1 npm start
```

The iOS app needs a Mac with Xcode 16 and XcodeGen: see
[iOS App with Xcode](https://github.com/Hornet-Linux/cadence-music/wiki/iOS-App-with-Xcode).
More in the wiki's [Development](https://github.com/Hornet-Linux/cadence-music/wiki/Development) page.

## CI

Every push and PR runs [ci.yml](.github/workflows/ci.yml):

- **Desktop:** lint, typecheck, Vitest with coverage on **Linux and Windows**,
  a production build with a clean-tree guard, a real-app launch test, and the
  packaged Windows `.exe` and macOS `.dmg` files on `main` and tags.
- **Server:** lint, typecheck and the `node:test` suite (including a full OIDC
  sign-in against a fake provider and real byte-range streaming).
- **Docker:** builds the server image and smoke-tests the running container —
  health check, sign-in, a library scan, a ranged stream, and a browser test of
  the web player.

[ios.yml](.github/workflows/ios.yml) builds the unsigned `Cadence.ipa` when
`apps/ios` changes. Pushing a `v*` tag publishes a GitHub Release with all four
downloads.
