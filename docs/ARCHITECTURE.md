# Architecture

Unnamed Music App is a **plugin-first** music player made of two parts that
live in this repository:

```
apps/desktop/     Electron desktop app (Windows .exe; also runs on Linux/macOS)
apps/server/      Self-hosted server (Docker) — accounts, OIDC, library, streaming
packages/shared/  Type-only HTTP API contract shared by both
deploy/           docker-compose, env template, Caddy example
docs/             This documentation
```

The desktop app works on its own (local files). Point it at your server to get
your whole library on every machine, with sign-in through your own identity
provider.

## Desktop app (`apps/desktop`)

| Concern | Choice |
| --- | --- |
| Shell | castlabs Electron 42 (Widevine DRM), frameless window with a custom title bar |
| UI | React 18 + TypeScript, hand-rolled CSS design system |
| State | Zustand stores (`player`, `pluginHost`, `nav`, per-plugin stores) |
| Build | Vite + `vite-plugin-electron`; electron-builder (optional VMP signing) |
| Tests | Vitest (jsdom) + a Playwright launch test of the built app |

**Process model.** The main process (`electron/`) owns the window and the
browser-based sign-ins (server OIDC and Spotify, both loopback + PKCE), installs
the Widevine CDM, and stores secrets with Electron `safeStorage` (OS keychain /
DPAPI). Spotify refresh tokens never leave the main process; the page only
receives short-lived access tokens. The preload exposes a deliberately small
bridge, `window.host`, through `contextBridge`; `nodeIntegration` is off and
`contextIsolation` is on (the preload runs unsandboxed because it is an ES
module). The renderer (`src/`) holds the UI and the plugin host.

**Playback.** `player/playerStore.ts` owns the queue, shuffle, repeat, seek and
volume. Each audio-source plugin may return either a URL, played by the shared
`<audio>` element (server, local files), or an `ExternalPlayback` handle that
drives the service's own player (Spotify's Web Playback SDK, Apple's MusicKit).
Exactly one backend is active at a time, and a load counter stops a slow source
from overriding a newer selection, so tracks from different services mix freely
in one queue.

**Library.** Library, Home and Search have no data of their own. They render a
section per *library source* contributed by plugins — the server, Spotify, Apple
Music and local files — so a new source plugin shows up everywhere
automatically.

**Streaming services.** Spotify and Apple Music connect only through their
official APIs. Spotify uses a per-installation developer app (client ID, no
secret). Apple Music needs a MusicKit key; it lives on the server, which mints
short-lived developer tokens for signed-in apps.

## Server (`apps/server`)

| Concern | Choice |
| --- | --- |
| Runtime | Node 22, TypeScript compiled with `tsc` |
| HTTP | Fastify 4 |
| Storage | SQLite via Node's built-in `node:sqlite`, versioned migrations |
| Tags | `music-metadata` |
| Tests | `node:test` against the compiled output |
| Deploy | Multi-stage Docker image, non-root, health-checked |

**Auth.** Sessions are random bearer tokens; only their SHA-256 hashes are
stored. Two sign-in methods:

- *Password* — scrypt-hashed, with per-IP failure rate limiting. An admin can be
  bootstrapped from `ADMIN_USERNAME`/`ADMIN_PASSWORD`.
- *OIDC* — authorization code + PKCE against any provider (Authentik, Keycloak,
  …). For the desktop app the server only redirects to loopback addresses, and
  hands back a one-time code bound to the app's own PKCE challenge, so a code
  intercepted on the machine is useless. ID-token claims (issuer, audience,
  authorized party, expiry, nonce) are validated; the token arrives directly
  from the provider's token endpoint over TLS, which OIDC Core allows in place
  of a signature check. Group claims can restrict sign-in and grant admin.

**Library and streaming.** The library is a built-in *server plugin*. It scans
`MUSIC_DIR` at start-up, periodically and on demand, re-reading tags only for
files whose size or modification time changed. Audio elements cannot send
headers, so the app asks for a short-lived HMAC-signed stream URL; the stream
endpoint supports byte ranges for seeking.

## Security notes

- The server binds to localhost in the provided compose file; expose it only
  through a TLS proxy.
- CORS allows any origin because the API uses bearer tokens, never cookies.
- Tokens on the desktop are encrypted at rest with the OS keychain.

## Roadmap

- Playlists and likes synced through the server.
- Spotify / Apple Music connector plugins (library import).
- Artwork extraction and caching.
- Signed, installable third-party plugin packages for both apps.
