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

## 1. Get the code and configure

```bash
git clone https://github.com/Hornet-Linux/unnamed_music_app.git
cd unnamed_music_app/deploy
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

Install the app, open **Settings → Server**, enter `music.example.com` and
click **Connect**. Then sign in with your admin account or with your SSO
provider.

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
   `unnamed-music`) and bind the users or groups that may use it.
3. Copy the **Client ID** and **Client Secret** from the provider, and the
   **OpenID Configuration Issuer** shown on the provider's overview page —
   it looks like `https://auth.example.com/application/o/unnamed-music/`.
4. Set these in `deploy/.env`:

   ```ini
   PUBLIC_URL=https://music.example.com
   OIDC_ISSUER=https://auth.example.com/application/o/unnamed-music/
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

## Updating

```bash
cd unnamed_music_app
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
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
