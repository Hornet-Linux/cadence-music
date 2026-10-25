# Architecture

Cadence is a **plugin-first** music player. Everything lives in this
repository:

```
apps/desktop/     Electron desktop app (Windows .exe, macOS .dmg) and the web player build
apps/server/      Self-hosted server (Docker) — accounts, OIDC, library, streaming,
                  history, likes and playlists
apps/ios/         SwiftUI shell that hosts the server's web player (see IOS.md)
packages/shared/  Type-only HTTP API contract shared by the app and server
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
| State | Zustand stores (`player`, `pluginHost`, `nav`, `history`, `collection`, `prefs`, per-plugin stores) |
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

**Likes, playlists and history.** `features/collection/collectionStore.ts` and
`features/history/historyStore.ts` keep them on the device. While signed in,
the server plugin attaches a remote (`collectionSync.ts`, `historySync.ts`):
it uploads what was made offline, then mirrors the server's copy.

**Navigation.** `app/navStore.ts` keeps a back/forward stack of routes, driven
by the title bar arrows, `Alt+←/→` and the mouse's back/forward buttons.

**Web player.** `vite build --mode web` builds the same UI as a website, served
by the server at `/app`; `src/platform/webHost.ts` provides `window.host` with
browser redirects and `localStorage`.

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

**Plugins.** `app.ts` registers the built-in server plugins: `core.library`,
`core.integrations` (Spotify app ID, Apple Music tokens), `core.history`,
`core.collection` (liked songs and playlists) and `core.admin` (`/admin`).
Tables: `users`, `sessions`, `tracks`, `plays`, `settings`, `likes` and
`playlists`; deleting a user cascades to everything they own.

## iOS app (`apps/ios`)

A SwiftUI app generated from `project.yml` with XcodeGen. It asks for the
server address, then shows the server's `/app` in a `WKWebView` with a
background audio session; lock-screen controls come from the page's Media
Session metadata. See [IOS.md](IOS.md).

## CI and releases

`ci.yml` lints, typechecks and tests both apps, builds and smoke-tests the
Docker image (including a browser test of the web player), and on `main` and
tags packages the Windows installer and the macOS disk images. A `v*` tag
publishes a GitHub Release. `ios.yml` builds an unsigned `Cadence.ipa` when
`apps/ios` changes and attaches it to tagged releases.

## Security notes

- The server binds to localhost in the provided compose file; expose it only
  through a TLS proxy.
- CORS allows any origin because the API uses bearer tokens, never cookies.
- Tokens on the desktop are encrypted at rest with the OS keychain.

## Roadmap

- Spotify playlists and albums, and Apple Music playlists, in the library.
- Artwork extraction and caching.
- Signed, installable third-party plugin packages for both apps.
