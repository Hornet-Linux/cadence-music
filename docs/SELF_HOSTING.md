# Self-hosting the server

The server stores accounts, scans your music folder and streams it to the
apps and the web player. It is one Docker container with a built-in database:
nothing else to install or manage.

## Docker Compose (recommended)

All you need is a machine with [Docker](https://docs.docker.com/engine/install/)
(Linux, a NAS, a Raspberry Pi 4/5, or Docker Desktop on Windows/macOS). The
image runs on both x86-64 and ARM.

1. Make a folder and download one file into it:

   ```bash
   mkdir cadence && cd cadence
   curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/Hornet-Linux/cadence-music/main/deploy/compose/docker-compose.yml
   ```

2. Open `docker-compose.yml` and change two lines:
   - the music folder, `./music:/music:ro` → for example `/srv/music:/music:ro`
     (the part before the colon is the folder on your machine);
   - `PUBLIC_URL`, the address you will open in the browser, for example
     `http://192.168.1.20:8787`.

   Everything else has sensible defaults and a comment saying what it does.
   No `.env` file is needed.

3. Start it:

   ```bash
   docker compose up -d
   ```

4. Open `http://<your machine>:8787/app`. A brand-new server asks for a
   **setup code**, which only someone who can see its logs has:

   ```bash
   docker compose logs cadence | grep "setup code"
   ```

   Enter it, pick your admin username and password, and you're done. Manage
   people, sign-up and single sign-on at `/admin`.

The music folder must be readable by the container's user (uid 1000); files
that are readable by everyone (the usual default) are fine.

### With HTTPS via Caddy

Have a domain name? Use the Caddy version instead, which gets and renews a
free HTTPS certificate by itself.

1. Point the domain's DNS (an **A record**) at the machine and open ports
   **80 and 443**.
2. Download the file as `docker-compose.yml`:

   ```bash
   mkdir cadence && cd cadence
   curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/Hornet-Linux/cadence-music/main/deploy/compose/docker-compose.caddy.yml
   ```

3. Replace `music.example.com` in the two marked places (`PUBLIC_URL` and
   `DOMAIN`) and set your music folder.
4. `docker compose up -d`, open `https://music.example.com/app` and enter the
   setup code from `docker compose logs cadence | grep "setup code"`.

Already run Caddy, nginx or Traefik? Use the plain file, remove the `ports:`
lines and point your proxy at the `cadence` container on port 8787 (see
[Reverse proxy](#3-reverse-proxy-caddy)).

### Updating

```bash
docker compose pull && docker compose up -d
```

Your accounts and settings live in the `cadence-data` volume and survive
updates. Database changes run automatically on start.

### Which image tag?

The image is `ghcr.io/hornet-linux/cadence-music` (registry names are always
lowercase). Change the tag on the `image:` line to choose what you get:

| Tag | What it is |
| --- | --- |
| `latest` | The newest stable release (the default). |
| `1.4.2` / `v1.4.2` | Exactly that release. It never changes. |
| `1.4` / `1` | The newest release in that line, so you get bug fixes but no big changes. |
| `nightly` / `main` | Built from every change to the main branch. Development builds. |
| `sha-abc1234` | One exact main-branch build. |

Pinning (`1.4` or `1.4.2`) is the safest choice for a server you don't want to
look after; `docker compose pull` then only moves within that line.

### Optional: the helper script

`deploy/install.sh` does the same as above with questions instead of editing,
and can also install Docker for you. It builds from source, so it needs `git`:

```bash
curl -fsSL https://raw.githubusercontent.com/Hornet-Linux/cadence-music/main/deploy/install.sh | bash
```

It asks for your domain and a few yes/no questions (press Enter for the
defaults), starts everything and prints the setup code. Lost it later?
`cd ~/cadence-music/deploy && docker compose logs server | grep "setup code"`.
If you already run a reverse proxy, answer "yes" when asked and it prints the
block to add to it instead of starting its own.

The rest of this page describes the build-from-source setup in
`deploy/docker-compose.yml` (used by the helper script) step by step, plus
single sign-on, streaming services and network shares, which work the same
way with either setup.

## 1. Get the code and configure (build from source)

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

### Client addresses and rate limits

Sign-in, sign-up and first-run setup are rate limited per client address, so the
server has to know the real address behind your proxy. By default it believes
`X-Forwarded-For` only from a proxy on the same machine or a private network
(loopback, `10.x`, `172.16-31.x`, `192.168.x`, link-local and unique-local),
and then uses the address that proxy appended. That covers the bundled Caddy,
Caddy or nginx on the host, and other containers on your Docker network (nginx
needs `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`; Caddy and
Traefik do this out of the box). A client on the open internet is never in those
ranges, so it can't forge the header to dodge the limits. If your proxy reaches
the server from a public address, list it: `TRUST_PROXY=203.0.113.10` or a
CIDR range (`TRUST_PROXY=172.18.0.0/16,10.0.0.5`). If clients reach the server
directly with no proxy, set `TRUST_PROXY=false`. A plain number (`TRUST_PROXY=2`)
means "believe that many hops" and is only safe when nobody can reach the
server except through your proxy.

## 4. Connect the desktop app

Install the app. The first-run wizard opens on its own (or use **Settings →
About → Run setup again**). Enter `music.example.com` and click **Connect**.
On a new server you'll be asked for the setup code to create the admin;
otherwise sign in with your account or your SSO provider. The remaining steps
connect Spotify and Apple Music, and you can skip any of them.

## Single sign-on with Authentik (OIDC)

The easiest way: open **/admin → Single sign-on**, copy the redirect
addresses shown there into your provider, then fill in the issuer, client ID
and secret and press **Test connection** and **Save**. It applies to the next
sign-in, with no restart. The secret is stored encrypted with the server
secret and never shown again. Any `OIDC_*` variable you set in the
environment wins over the page and shows as locked there.

The steps below use environment variables instead, with Authentik as the example.

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

## Music on a network share (SMB/CIFS and NFS)

Cadence does not speak SMB or NFS itself. A pure JavaScript SMB client would be a large piece of security-sensitive
code (and NFS needs kernel support), and no small, actively maintained library for it exists. The reliable way is the
one your operating system already has: **mount the share, then give Cadence the mounted folder as its music library.**
The library scanner, tag reader, search and streaming all work on a mounted share exactly as they do on a local disk.

Two ways to do it. The first is simpler and fits every setup.

### A. Mount on the host, then point `MUSIC_PATH` at it

1. Mount the share on the machine that runs Docker. For SMB/CIFS, keep the password in a file only root can read
   (never in `fstab` or a compose file):

   ```bash
   sudo apt install cifs-utils            # Debian/Ubuntu; "nfs-common" for NFS
   sudo mkdir -p /mnt/nas-music
   sudo install -m 600 /dev/null /etc/cadence-nas.cred
   printf 'username=cadence\npassword=YOUR-PASSWORD\n' | sudo tee /etc/cadence-nas.cred >/dev/null
   ```

   Add one line to `/etc/fstab` (read-only, readable by the container's user, uid 1000):

   ```fstab
   //nas.local/music  /mnt/nas-music  cifs  credentials=/etc/cadence-nas.cred,ro,uid=1000,gid=1000,file_mode=0444,dir_mode=0555,vers=3.0,_netdev,nofail  0  0
   ```

   For NFS:

   ```fstab
   nas.local:/volume1/music  /mnt/nas-music  nfs  ro,nfsvers=4,_netdev,nofail  0  0
   ```

   Then `sudo mount /mnt/nas-music` and check with `ls /mnt/nas-music`.

2. In `deploy/.env` set:

   ```ini
   MUSIC_PATH=/mnt/nas-music
   ```

3. `docker compose up -d` (or `docker compose restart server`). The first scan runs on start.

### B. Let Docker mount the share (named volume)

If you would rather not touch the host's `fstab`, create `deploy/docker-compose.override.yml`. Compose merges it
with `docker-compose.yml` and, because both mount something at `/music`, the share replaces the bind mount:

```yaml
# deploy/docker-compose.override.yml  (SMB/CIFS)
services:
  server:
    volumes:
      - nas-music:/music:ro

volumes:
  nas-music:
    driver: local
    driver_opts:
      type: cifs
      device: "//nas.local/music"
      o: "addr=nas.local,username=cadence,password=${NAS_PASSWORD},vers=3.0,ro,uid=1000,gid=1000,file_mode=0444,dir_mode=0555"
```

```yaml
# deploy/docker-compose.override.yml  (NFS)
services:
  server:
    volumes:
      - nas-music:/music:ro

volumes:
  nas-music:
    driver: local
    driver_opts:
      type: nfs
      device: ":/volume1/music"
      o: "addr=nas.local,ro,nfsvers=4"
```

Put `NAS_PASSWORD=...` in `deploy/.env` (it is already ignored by git). Note that the compose file hands the whole `.env`
to the server container, so that password also ends up in the container's environment; for SMB with a real password,
method A (credentials file on the host) keeps it out of Docker entirely. Check the result with
`docker compose config` before starting. A named volume is created once: if you change `driver_opts`, run
`docker compose down` and `docker volume rm cadence_nas-music` first.

### Good to know

- **Use a read-only account** on the NAS. Cadence only ever reads.
- **New files are found by the periodic rescan**, not instantly, because network shares don't send change
  notices. `SCAN_INTERVAL_MINUTES` (default 60) sets how often; `POST /api/library/scan` (admin) starts one now.
- **The first scan of a big library over the network is slow** (every file's tags are read). Later scans only
  read files that changed.
- **A share that is offline at start-up** looks like an empty folder. With `nofail` in `fstab` the server still
  starts; once the share is back, run a scan. Cadence never deletes anything on the share.
- **SMB version**: modern NAS boxes want `vers=3.0` (or `3.1.1`). If mounting fails with "operation not
  supported", try another version.
- **A NAS that speaks WebDAV** (Synology, QNAP, TrueNAS and most others can) can skip all of this: use the
  WebDAV source instead, see [CLOUD_SOURCES.md](CLOUD_SOURCES.md).

## Updating

With Docker Compose: `docker compose pull && docker compose up -d`.

With the helper script, run the installer again; it pulls the latest version and rebuilds:

```bash
curl -fsSL https://raw.githubusercontent.com/Hornet-Linux/cadence-music/main/deploy/install.sh | bash
```

Or by hand: `cd ~/cadence-music && git pull && cd deploy && docker compose up -d --build`.

Database migrations run automatically on start.

## Configuration reference

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | Port inside the container. |
| `DATA_DIR` | `/data` | Database and secret. |
| `MUSIC_DIR` | `/music` | Music library root (read-only is fine). |
| `PUBLIC_URL` | — | Public base URL; required for OIDC. |
| `SCAN_INTERVAL_MINUTES` | `60` | Periodic rescan; `0` disables. |
| `TRUST_PROXY` | private-network proxies | Proxies whose `X-Forwarded-For` to believe: `false` (none, for direct exposure), a hop count, or comma-separated proxy IPs/CIDR ranges. Default is proxies on this machine or a private network. |
| `PREVIOUS_SERVER_SECRET` | — | When rotating `SERVER_SECRET`: the old value(s), comma-separated, so saved AI provider keys are re-encrypted instead of lost. Remove after one start. |
| `SERVER_SECRET` | generated | Signs stream URLs; generated into `DATA_DIR` if unset. |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | — | Bootstrap admin account. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | — | Enable OIDC. |
| `OIDC_NAME` | `Single sign-on` | Sign-in button label. |
| `OIDC_SCOPES` | `openid profile email` | Requested scopes. |
| `OIDC_ALLOWED_GROUPS` | — | Restrict sign-in to these groups. |
| `OIDC_ADMIN_GROUPS` | — | Grant admin to these groups. |
| `SIGNUP_MODE` | `closed` | `open` or `invite` to allow self-service sign-up (page at `/` and in the app). |
| `SIGNUP_INVITE_CODE` | — | Code people must enter when `SIGNUP_MODE=invite`. Use at least 12 characters. |
| `APP_DOWNLOAD_URL` | GitHub releases | Download link shown on the sign-up page. |
| `SPOTIFY_CLIENT_ID` | — | Spotify app ID shared with signed-in apps. |
| `JELLYFIN_URL` | — | Address of your Jellyfin server, as the Cadence server reaches it (e.g. `http://jellyfin:8096`). Only the owner sets it. See [Jellyfin](JELLYFIN.md). |
| `APPLE_MUSIC_TEAM_ID`, `APPLE_MUSIC_KEY_ID` | — | Apple Developer team and MusicKit key IDs. |
| `APPLE_MUSIC_PRIVATE_KEY` / `_FILE` | — | MusicKit `.p8` key (inline with `\n`, or a file path). |
| `SOURCES_ALLOW_PRIVATE_NETWORK` | `false` | Let WebDAV, S3 and cloud-drive sources connect to servers on a private network (a NAS at home). See [CLOUD_SOURCES.md](CLOUD_SOURCES.md). |
| `OLLAMA_URL` | — | An Ollama the server calls for the AI DJ, normally the bundled one: `http://ollama:11434` with `ollama` or `ollama-gpu` in `COMPOSE_PROFILES`. Added as the default AI provider. See [AI DJ](AI_DJ.md). |
| `OLLAMA_MODEL` | `llama3.2:3b` | Model the server downloads into that Ollama on first start. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
