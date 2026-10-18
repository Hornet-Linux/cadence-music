# unnamed_music_app

[![CI](https://github.com/Hornet-Linux/unnamed_music_app/actions/workflows/ci.yml/badge.svg)](https://github.com/Hornet-Linux/unnamed_music_app/actions/workflows/ci.yml)

A music player you own end to end: a desktop app for your computer and a
server you host yourself. **Plugin-first** — the app is a clean player shell,
and almost everything else (where music comes from, sign-in, service
connections) is a plugin, on both the desktop and the server.

## What's here

- **Desktop app** (`apps/desktop`) — Electron, ships as a Windows `.exe`. Plays
  local files on its own, or connects to your server.
- **Self-hosted server** (`apps/server`) — one Docker container. Scans your music
  folder, streams it with seeking, and handles accounts.
- **Single sign-on** — OIDC with any provider (Authentik, Keycloak, …) plus an
  optional local admin account.
- **Plugins** — capability-based plugins on the desktop, and the same plugin
  seam on the server.

## Quick start

**Server** (on your VPS — full guide in [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)):

```bash
git clone https://github.com/Hornet-Linux/unnamed_music_app.git
cd unnamed_music_app/deploy
cp .env.example .env   # set MUSIC_PATH, PUBLIC_URL, admin and/or OIDC
docker compose up -d --build
```

Then put a TLS proxy (e.g. Caddy) in front of `127.0.0.1:8787`.

**Desktop:** install the `.exe` from the latest CI run's `windows-installer`
artifact, open **Settings → Server** and connect to your domain.

## Development

Requires **Node.js 22+**. Each app installs on its own:

```bash
cd apps/desktop
npm install
npm run dev          # Electron app with hot reload
npm run lint && npm run typecheck && npm test

cd ../server
npm install
npm test             # compiles, then runs node:test
npm run build
MUSIC_DIR=~/Music ADMIN_USERNAME=admin ADMIN_PASSWORD=admin npm start
```

## CI

Every push and PR runs [ci.yml](.github/workflows/ci.yml):

- **Desktop:** lint, typecheck, Vitest with coverage on **Linux and Windows**,
  a production build with a clean-tree guard, and a packaged Windows `.exe` on
  `main` and tags.
- **Server:** lint, typecheck and the `node:test` suite (including a full OIDC
  sign-in against a fake provider and real byte-range streaming).
- **Docker:** builds the server image and smoke-tests the running container —
  health check, sign-in, a library scan and a ranged stream.

## Documentation

- [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) — deploy the server, Caddy,
  Authentik/OIDC setup, configuration reference.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how it fits together.
- [docs/PLUGINS.md](docs/PLUGINS.md) — desktop and server plugins.
