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
  server in the background with lock-screen controls. See [docs/IOS.md](docs/IOS.md).
- **Android app** (`apps/android`) — a native shell around your server's web
  player; sideload the APK. See [docs/ANDROID.md](docs/ANDROID.md).
- **Self-hosted server** (`apps/server`) — one Docker container. Scans your music
  folder, streams it with seeking, and handles accounts.
- **Single sign-on** — OIDC with any provider (Authentik, Keycloak, …) plus an
  optional local admin account.
- **Spotify and Apple Music** — official sign-in, your library in the app, and
  full in-app playback (Premium / subscription), mixed in one queue with your
  own music. See [setup](docs/SELF_HOSTING.md#spotify-and-apple-music).
- **Jellyfin** — browse, search and play your Jellyfin music through your Cadence
  server, with cover art, favourites, playlists and play counts reported back.
  The server owner sets the Jellyfin address; everyone signs in with their own
  Jellyfin account. See [docs/JELLYFIN.md](docs/JELLYFIN.md).
- **Music from elsewhere** — WebDAV (Nextcloud, ownCloud, NAS), S3-compatible storage,
  Google Drive and OneDrive (experimental), plus Bandcamp links; SMB/NFS shares via
  the normal library. See [docs/CLOUD_SOURCES.md](docs/CLOUD_SOURCES.md).
- **AI DJ** — a nonstop, personalised mix with short spoken intros, like
  Spotify's DJ. Songs are picked by an LLM you choose: a model on your own
  computer (**[Ollama](https://ollama.com)**, LM Studio, llama.cpp…), a provider
  the server owner sets up for everyone (OpenAI-compatible APIs, Anthropic), or
  one of your own computers shared with your phone. Needs Spotify or Jellyfin. See
  [AI DJ](#ai-dj).
- **Plugins** — capability-based plugins on the desktop, and the same plugin
  seam on the server.

## Quick start

**1. Run the server** with Docker Compose (recommended). On any machine with Docker:

```bash
mkdir cadence && cd cadence
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/Hornet-Linux/cadence-music/main/deploy/compose/docker-compose.yml
# edit the music folder and PUBLIC_URL in docker-compose.yml, then:
docker compose up -d
```

No `.env` file needed. Want HTTPS for a domain? Use
[`docker-compose.caddy.yml`](deploy/compose/docker-compose.caddy.yml) instead.
Update with `docker compose pull && docker compose up -d`. Image tags, the
optional helper script and troubleshooting: [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).
Step-by-step guides for every setup are in the wiki's
[Self-Hosting](https://github.com/Hornet-Linux/cadence-music/wiki/Self-Hosting) page.

**2. Claim it:** open `http://your-server:8787/app` (or your domain), enter the
setup code from `docker compose logs cadence | grep "setup code"` and choose
your admin login. Manage people and single sign-on at `/admin`.

**3. Listen** in the browser at `/app`, or install an app:

- **Windows:** [Cadence-Setup.exe](https://github.com/Hornet-Linux/cadence-music/releases/latest/download/Cadence-Setup.exe)
- **macOS (Apple Silicon):** [Cadence-mac-arm64.dmg](https://github.com/Hornet-Linux/cadence-music/releases/latest/download/Cadence-mac-arm64.dmg)
- **macOS (Intel):** [Cadence-mac-x64.dmg](https://github.com/Hornet-Linux/cadence-music/releases/latest/download/Cadence-mac-x64.dmg)
- **iPhone / iPad:** [Cadence.ipa](https://github.com/Hornet-Linux/cadence-music/releases/latest/download/Cadence.ipa), sideloaded with a free Apple ID ([how](https://github.com/Hornet-Linux/cadence-music/wiki/iOS-App))
- **Android:** [Cadence.apk](https://github.com/Hornet-Linux/cadence-music/releases/latest/download/Cadence.apk), sideloaded ([how](docs/ANDROID.md))

Between versioned releases, every push to `main` refreshes the [Nightly](https://github.com/Hornet-Linux/cadence-music/releases/tag/nightly) pre-release with the newest build of every app, with no sign-in needed: 
[Cadence-Setup.exe](https://github.com/Hornet-Linux/cadence-music/releases/download/nightly/Cadence-Setup.exe), 
[Cadence-mac-arm64.dmg](https://github.com/Hornet-Linux/cadence-music/releases/download/nightly/Cadence-mac-arm64.dmg), 
[Cadence.apk](https://github.com/Hornet-Linux/cadence-music/releases/download/nightly/Cadence.apk) (signed, with a `.sha256` next to it) and 
[Cadence.ipa](https://github.com/Hornet-Linux/cadence-music/releases/download/nightly/Cadence.ipa). These are development builds.

The Mac app isn't notarized by Apple, so the first time, open it with
right-click → **Open** (or System Settings → Privacy & Security → **Open Anyway**).

To update the server later, run the same command again.

**4. Connect services:** [Spotify](https://github.com/Hornet-Linux/cadence-music/wiki/Spotify)
(free developer app, Premium for playback) and
[Apple Music](https://github.com/Hornet-Linux/cadence-music/wiki/Apple-Music)
(needs a MusicKit key on the server) and
[Jellyfin](docs/JELLYFIN.md) (the server owner sets its address in the admin page).

## AI DJ

The DJ on the Home page asks an LLM for songs, then checks every suggestion
against Spotify so made-up tracks are skipped. Intros are spoken with your
operating system's built-in voices. You choose where the model runs in
Settings → **AI DJ**:

| Where it runs | Good for | API key lives |
| --- | --- | --- |
| **On the server** (the server owner adds it in Settings → AI DJ) | Phones, browsers and anything without a local model | On the server, encrypted. Never sent to any app |
| **On this device** (Ollama, LM Studio, llama.cpp, or an OpenAI/Anthropic/… key you type in) | Keeping everything on your own machine | On this device, in secure storage |
| **On another of your computers**, shared through the server | Using your desktop's Ollama from your phone | On that computer |

Any OpenAI-compatible server works (OpenAI, LM Studio, llama.cpp, vLLM, Jan,
OpenRouter, Groq, Together, Mistral, DeepSeek, xAI, Gemini's compatibility
endpoint…), as do Ollama and Anthropic. Details and the server API:
[docs/AI_DJ.md](docs/AI_DJ.md).

**Quick start with Ollama on this computer:**

1. Install Ollama from [ollama.com/download](https://ollama.com/download).
2. Download the default model (about 2 GB):
   ```bash
   ollama pull llama3.2:3b
   ```
3. Connect Spotify, then press **Start DJ** on Home. Settings → **AI DJ** has
   the provider, model and voice toggle.

**System requirements** (for Ollama and the default model, on top of the app):

| | Minimum | Recommended |
| --- | --- | --- |
| Memory (RAM) | 8 GB | 16 GB |
| Processor | 64-bit, 4 cores (AVX2 support recommended) | 6+ cores, or Apple Silicon |
| Graphics | Not required, runs on the CPU | Any GPU with 4 GB+ VRAM that Ollama supports |
| Free disk | 3 GB | 5 GB |
| Time to pick a set | ~30–90 s on CPU | a few seconds |

On very old or low-memory machines (4–8 GB RAM), pick `llama3.2:1b` instead
(about 1.3 GB). It's faster but suggests more songs that don't exist, so sets
can come out shorter. Larger models such as `qwen3:8b` pick better songs if you
have 16 GB of RAM or a GPU. See the [AI DJ wiki page](https://github.com/Hornet-Linux/cadence-music/wiki/AI-DJ) for more.

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
- [docs/ANDROID.md](docs/ANDROID.md) — the Android app and the Nightly downloads.
- [docs/AI_DJ.md](docs/AI_DJ.md) — the AI DJ: providers, device sharing, the server API.
- [docs/JELLYFIN.md](docs/JELLYFIN.md) — play your Jellyfin library through the server.

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

## Documentation

- [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) — deploy the server, Caddy,
  Authentik/OIDC setup, configuration reference.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how it fits together.
- [docs/PLUGINS.md](docs/PLUGINS.md) — desktop and server plugins.
- [docs/CLOUD_SOURCES.md](docs/CLOUD_SOURCES.md) — WebDAV, S3, Google Drive/OneDrive;
  [docs/BANDCAMP.md](docs/BANDCAMP.md) — Bandcamp.
