# Cadence

[![CI](https://github.com/Hornet-Linux/cadence-music/actions/workflows/ci.yml/badge.svg)](https://github.com/Hornet-Linux/cadence-music/actions/workflows/ci.yml)

A music player you own end to end: a desktop app for your computer and a
server you host yourself. **Plugin-first** — the app is a clean player shell,
and almost everything else (where music comes from, sign-in, service
connections) is a plugin, on both the desktop and the server.

## What's here

- **Desktop app** (`apps/desktop`) — Electron, ships for Windows (`.exe`) and macOS (`.dmg`). Plays
  local files on its own, or connects to your server.
- **iOS app** (`apps/ios`) — sideloaded with a free Apple ID; plays from your
  server in the background. See [docs/IOS.md](docs/IOS.md).
- **Android app** (`apps/android`) � a native shell around your server's web
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
- **AI DJ** — a nonstop, personalised mix with short spoken intros, like
  Spotify's DJ. Songs are picked by an LLM you choose: a model on your own
  computer (**[Ollama](https://ollama.com)**, LM Studio, llama.cpp…), a provider
  the server owner sets up for everyone (OpenAI-compatible APIs, Anthropic), or
  one of your own computers shared with your phone. Needs Spotify or Jellyfin. See
  [AI DJ](#ai-dj).
- **Plugins** — capability-based plugins on the desktop, and the same plugin
  seam on the server.

## Quick start

**1. Run the server** on any Linux VPS, after pointing a domain's DNS at it:

```bash
curl -fsSL https://raw.githubusercontent.com/Hornet-Linux/cadence-music/main/deploy/install.sh | bash
```

That installs Docker if needed, asks a few questions (Enter accepts the
defaults), sets up HTTPS and prints a one-time setup code. Details and
troubleshooting: [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

**2. Claim it:** open `https://your-domain/app`, enter the setup code and choose
your admin login. Manage people at `https://your-domain/admin`.

**3. Listen** in the browser at `/app`, or install the app:

- **Windows:** [Cadence-Setup.exe](https://github.com/Hornet-Linux/cadence-music/releases/latest/download/Cadence-Setup.exe)
- **macOS (Apple Silicon):** [Cadence-mac-arm64.dmg](https://github.com/Hornet-Linux/cadence-music/releases/latest/download/Cadence-mac-arm64.dmg)
- **macOS (Intel):** [Cadence-mac-x64.dmg](https://github.com/Hornet-Linux/cadence-music/releases/latest/download/Cadence-mac-x64.dmg)
- **iPhone / iPad:** [Cadence.ipa](https://github.com/Hornet-Linux/cadence-music/releases/latest/download/Cadence.ipa), sideloaded with a free Apple ID ([how](docs/IOS.md))
- **Android:** [Cadence.apk](https://github.com/Hornet-Linux/cadence-music/releases/latest/download/Cadence.apk), sideloaded ([how](docs/ANDROID.md))

Between versioned releases, every push to `main` refreshes the [Nightly](https://github.com/Hornet-Linux/cadence-music/releases/tag/nightly) pre-release with the newest build of every app, with no sign-in needed: 
[Cadence-Setup.exe](https://github.com/Hornet-Linux/cadence-music/releases/download/nightly/Cadence-Setup.exe), 
[Cadence-mac-arm64.dmg](https://github.com/Hornet-Linux/cadence-music/releases/download/nightly/Cadence-mac-arm64.dmg), 
[Cadence.apk](https://github.com/Hornet-Linux/cadence-music/releases/download/nightly/Cadence.apk) (signed, with a `.sha256` next to it) and 
[Cadence.ipa](https://github.com/Hornet-Linux/cadence-music/releases/download/nightly/Cadence.ipa). These are development builds.

The Mac app isn't notarized by Apple, so the first time, open it with
right-click → **Open** (or System Settings → Privacy & Security → **Open Anyway**).

To update the server later, run the same command again.

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
