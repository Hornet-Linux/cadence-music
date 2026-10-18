# Self-hosting the server

The server stores accounts, scans your music folder and streams it to the
desktop app. It runs as a single Docker container with an embedded SQLite
database — no separate database to manage.

## Requirements

- A Linux host with Docker and Docker Compose (any VPS works; it needs very
  little RAM).
- A domain or subdomain pointing at the host, e.g. `music.example.com`.
- A TLS reverse proxy. Examples use [Caddy](https://caddyserver.com), which
  handles certificates automatically.
- Your music in a folder on the host. Formats: MP3, FLAC, M4A/AAC, Ogg/Opus,
  WAV, WebM.

## Quick start: the setup wizard

```bash
git clone https://github.com/Hornet-Linux/cadence-music.git
cd cadence-music/deploy
./setup.sh
```

The wizard asks for your domain, music folder and port, and optionally your
OIDC provider (Authentik etc.), a Spotify app ID and an Apple Music key. It
writes `deploy/.env` (readable only by you), prints the Caddy block for your
domain, and can build and start the server. Re-run it any time; it backs up the
old `.env` first.

On first start, a server with no accounts prints a **one-time setup code**:

```bash
docker compose logs server | grep "setup code"
```

Open the desktop app. Its first-run wizard asks for your server's address,
then for that code, and creates your admin account. The code works once, so
nobody who finds your new server before you do can claim it.

The sections below describe the same steps by hand, for when you'd rather edit
files yourself.

## 1. Get the code and configure (manual)

```bash
git clone https://github.com/Hornet-Linux/cadence-music.git
cd cadence-music/deploy
cp .env.example .env
```

Edit `.env`:

| Variable | What to set |
| --- | --- |
| `MUSIC_PATH` | Absolute path to your music folder on the host, e.g. `/srv/music`. |
| `HOST_PORT` | Port on `127.0.0.1` for the proxy to reach (default `8787`). |
| `PUBLIC_URL` | Your server's address, e.g. `https://music.example.com`. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Optional local admin, created on first start. |
| `OIDC_*` | Optional single sign-on — see below. |

The music folder must be readable by the container's user (uid 1000). Files
that are world-readable (the usual default) are fine.

## 2. Start it

```bash
docker compose up -d --build
docker compose logs -f server   # watch the first library scan
```

The server binds to `127.0.0.1:${HOST_PORT}` only, so it is not reachable from
the internet until you put the proxy in front of it.

Data (database, generated secret) lives in the `music-data` Docker volume.
Back it up with your usual volume backups.

## 3. Reverse proxy (Caddy)

Add a site block (see `deploy/Caddyfile.example`):

```caddy
music.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8787
}
```

Reload Caddy. Once DNS points at the host, `https://music.example.com/api/health`
should return JSON.

## 4. Connect the desktop app

Install the app. The first-run wizard opens on its own (or use **Settings →
About → Run setup again**). Enter `music.example.com` and click **Connect**.
On a new server you'll be asked for the setup code to create the admin;
otherwise sign in with your account or your SSO provider. The remaining steps
connect Spotify and Apple Music, and you can skip any of them.

## Single sign-on with Authentik (OIDC)

1. In Authentik, go to **Applications → Providers → Create** and choose
   **OAuth2/OpenID Provider**.
   - **Client type:** Confidential
   - **Redirect URIs:** `https://music.example.com/api/auth/oidc/callback`
     (strict match)
   - **Scopes:** keep the defaults (`openid`, `profile`, `email`). Authentik's
     `profile` scope includes the user's groups.
   - **Subject mode:** the default ("Based on the User's hashed ID") is fine.
2. Create an **Application** that uses this provider (slug e.g.
   `cadence`) and bind the users or groups that may use it.
3. Copy the **Client ID** and **Client Secret** from the provider, and the
   **OpenID Configuration Issuer** shown on the provider's overview page —
   it looks like `https://auth.example.com/application/o/cadence/`.
4. Set these in `deploy/.env`:

   ```ini
   PUBLIC_URL=https://music.example.com
   OIDC_ISSUER=https://auth.example.com/application/o/cadence/
   OIDC_CLIENT_ID=...
   OIDC_CLIENT_SECRET=...
   OIDC_NAME=Authentik
   # Optional:
   OIDC_ALLOWED_GROUPS=music-users
   OIDC_ADMIN_GROUPS=music-admins
   ```

5. `docker compose up -d` to apply. The app's Server settings now show a
   **Sign in with Authentik** button.

Any standards-compliant OIDC provider (Keycloak, Authelia, Zitadel, Google…)
works the same way: register the redirect URI above and set the issuer, client
id and secret.

### How desktop sign-in works

The app follows the native-app pattern from RFC 8252. It opens your system
browser at the server, which sends you to the provider. After you sign in, the
server redirects to a temporary listener on `127.0.0.1` inside the app with a
one-time code. The app proves it started the flow (PKCE) and receives a session
token, stored encrypted with your OS keychain. The provider's client secret
never leaves the server.

## Spotify and Apple Music

Both connect through their official APIs and play inside the app, using the
desktop build's Widevine DRM support (castlabs Electron).

### Spotify (Premium required for playback)

1. Go to the [Spotify developer dashboard](https://developer.spotify.com/dashboard)
   and create an app.
2. Add the redirect URI `http://127.0.0.1:43821/callback`, and select
   **Web API** and **Web Playback SDK**.
3. Under **User Management**, add the email of every Spotify account that will
   use it. Apps that Spotify hasn't reviewed are limited to a small allowlist
   of users, which is fine for a household.
4. Either set `SPOTIFY_CLIENT_ID=<client id>` in `deploy/.env` (every app that
   signs in to your server picks it up), or paste the Client ID into
   **Settings → Spotify** in the app.
5. In the app, click **Connect Spotify**, approve in the browser, and your
   liked songs appear in the library.

Port 43821 must be free on the computer while you sign in.

### Apple Music (Apple Developer Program membership required)

Every third-party Apple Music app needs a MusicKit key, and only members of the
Apple Developer Program ($99/year) can create one. Listeners also need an
Apple Music subscription to play songs.

1. At [developer.apple.com](https://developer.apple.com/account/resources/authkeys/list),
   create a key with **Media Services (MusicKit)** enabled and download the
   `.p8` file. Note the **Key ID** and your **Team ID**.
2. Add them to `deploy/.env`:

   ```ini
   APPLE_MUSIC_TEAM_ID=ABCDE12345
   APPLE_MUSIC_KEY_ID=XYZ9876543
   APPLE_MUSIC_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIGT...\n-----END PRIVATE KEY-----
   ```

3. Restart the server (`docker compose up -d`). The key never leaves the
   server; signed-in apps receive short-lived developer tokens from
   `/api/integrations/apple-music/token`.
4. In the app, **Settings → Apple Music → Connect**, then sign in with your
   Apple ID in Apple's window.

### DRM signing for the Windows build

Streaming services only license DRM playback to apps that are Widevine
VMP-signed. The CI signs the Windows installer automatically when two
repository secrets are set:

1. Create a free account with castlabs EVS:
   `pip install castlabs-evs` then `python -m castlabs_evs.account signup`.
2. In GitHub → repository → **Settings → Secrets and variables → Actions**, add
   `EVS_ACCOUNT_NAME` and `EVS_PASSWD`.

Without them the installer still builds, but Spotify and Apple Music may refuse
to play.

## Updating

```bash
cd cadence-music
git pull
cd deploy
docker compose up -d --build
```

Database migrations run automatically on start.

## Configuration reference

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | Port inside the container. |
| `DATA_DIR` | `/data` | Database and secret. |
| `MUSIC_DIR` | `/music` | Music library root (read-only is fine). |
| `PUBLIC_URL` | — | Public base URL; required for OIDC. |
| `SCAN_INTERVAL_MINUTES` | `60` | Periodic rescan; `0` disables. |
| `TRUST_PROXY` | `true` | Trust `X-Forwarded-*` from the proxy. |
| `SERVER_SECRET` | generated | Signs stream URLs; generated into `DATA_DIR` if unset. |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | — | Bootstrap admin account. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | — | Enable OIDC. |
| `OIDC_NAME` | `Single sign-on` | Sign-in button label. |
| `OIDC_SCOPES` | `openid profile email` | Requested scopes. |
| `OIDC_ALLOWED_GROUPS` | — | Restrict sign-in to these groups. |
| `OIDC_ADMIN_GROUPS` | — | Grant admin to these groups. |
| `SPOTIFY_CLIENT_ID` | — | Spotify app ID shared with signed-in apps. |
| `APPLE_MUSIC_TEAM_ID`, `APPLE_MUSIC_KEY_ID` | — | Apple Developer team and MusicKit key IDs. |
| `APPLE_MUSIC_PRIVATE_KEY` / `_FILE` | — | MusicKit `.p8` key (inline with `\n`, or a file path). |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
