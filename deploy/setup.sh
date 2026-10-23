#!/usr/bin/env bash
# Interactive setup for the Cadence server.
#
#   cd deploy && ./setup.sh
#
# Asks a few questions, writes deploy/.env, prints the Caddy config for your
# domain and can build and start the server. Safe to re-run: an existing .env
# is backed up first. Answers can also be piped in (CI does this).
set -euo pipefail

cd "$(dirname "$0")"
ENV_FILE=".env"

if [ -t 1 ]; then
  BOLD=$'\033[1m' DIM=$'\033[2m' ACCENT=$'\033[1;35m' WARN=$'\033[33m' RESET=$'\033[0m'
else
  BOLD="" DIM="" ACCENT="" WARN="" RESET=""
fi

section() { printf '\n%s== %s ==%s\n' "$ACCENT" "$*" "$RESET"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  %s! %s%s\n' "$WARN" "$*" "$RESET"; }
fail() {
  printf '\n%sSetup stopped:%s %s\n' "$WARN" "$RESET" "$*" >&2
  exit 1
}

# ask VAR "Question" [default]
ask() {
  local __name=$1 __prompt=$2 __default=${3-} __reply=""
  if [ -n "$__default" ]; then __prompt="$__prompt [$__default]"; fi
  printf '%s%s%s: ' "$BOLD" "$__prompt" "$RESET" >&2
  IFS= read -r __reply || true
  printf -v "$__name" '%s' "${__reply:-$__default}"
}

# ask_secret VAR "Question" — hidden when typing in a terminal.
ask_secret() {
  local __name=$1 __reply=""
  printf '%s%s%s: ' "$BOLD" "$2" "$RESET" >&2
  if [ -t 0 ]; then
    IFS= read -rs __reply || true
    printf '\n' >&2
  else
    IFS= read -r __reply || true
  fi
  printf -v "$__name" '%s' "$__reply"
}

# confirm "Question" [y|n default]
confirm() {
  local __default=${2:-n} __reply="" __hint="[y/N]"
  if [ "$__default" = y ]; then __hint="[Y/n]"; fi
  printf '%s%s%s %s: ' "$BOLD" "$1" "$RESET" "$__hint" >&2
  IFS= read -r __reply || true
  __reply=${__reply:-$__default}
  [[ $__reply =~ ^[Yy] ]]
}

# ask_valid VAR "Question" "regex" "error message" [default]
ask_valid() {
  local __name=$1 __prompt=$2 __re=$3 __msg=$4 __default=${5-} __try
  for __try in 1 2 3; do
    ask "$__name" "$__prompt" "$__default"
    if [[ ${!__name} =~ $__re ]]; then return 0; fi
    warn "$__msg"
  done
  fail "$__msg"
}

# Quote a value for docker compose's .env parser (single quotes: no expansion).
envq() {
  case $1 in *"'"*) fail "values can't contain single quotes" ;; esac
  printf "'%s'" "$1"
}

printf '%sCadence — server setup%s\n' "$BOLD" "$RESET"
info "This writes deploy/.env. Press Enter to accept a [default]."

# Use sudo for Docker when this user isn't in the docker group.
DOCKER=(docker)
if ! command -v docker >/dev/null 2>&1; then
  warn "Docker isn't installed. The one-line installer can set it up: see the README."
elif ! docker info >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  DOCKER=(sudo docker)
fi

if [ -f "$ENV_FILE" ]; then
  if confirm "A .env already exists. Replace it (a backup is kept)?" n; then
    backup="$ENV_FILE.backup-$(date +%Y%m%d-%H%M%S)"
    cp "$ENV_FILE" "$backup"
    info "Saved the old file as $backup"
  else
    info "Keeping your existing .env. Nothing changed."
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
section "Address"
info "The domain (or subdomain) people will use, pointing at this machine."
ask_valid DOMAIN "Domain" '^(https?://)?([A-Za-z0-9-]+\.)+[A-Za-z]{2,}(:[0-9]+)?/?$' \
  "Enter a domain like music.example.com."
DOMAIN=${DOMAIN#http://}
DOMAIN=${DOMAIN#https://}
DOMAIN=${DOMAIN%/}
PUBLIC_URL="https://$DOMAIN"

# ---------------------------------------------------------------------------
section "HTTPS"
info "Cadence can run its own web server (Caddy) that gets a free HTTPS"
info "certificate for $DOMAIN. Choose this unless something else on this"
info "machine already serves websites on ports 80 and 443."
proxy_default=n
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -qE "[:.](80|443) "; then
  proxy_default=y
  warn "Something is already using port 80 or 443 here, probably a web server."
fi
BUNDLED_HTTPS=1
if confirm "Do you already run a web server (Caddy, nginx, Traefik) on this machine?" "$proxy_default"; then
  BUNDLED_HTTPS=""
fi

ask_valid HOST_PORT "Local port for the reverse proxy to reach" '^[0-9]{2,5}$' \
  "Enter a port number such as 8787." 8787
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q "[:.]$HOST_PORT "; then
  warn "Something is already listening on port $HOST_PORT. Pick another if the server fails to start."
fi

# ---------------------------------------------------------------------------
section "Music files (optional)"
info "Streaming services don't need this. Only if you keep music files on this"
info "machine can the server stream them to your apps too."
MUSIC_PATH="./music"
if confirm "Do you keep music files on this server?" n; then
  ask_valid MUSIC_PATH "Music folder" '^/' "Use an absolute path such as /srv/music." /srv/music
  MUSIC_PATH=${MUSIC_PATH%/}
  if [ ! -d "$MUSIC_PATH" ]; then
    warn "$MUSIC_PATH doesn't exist yet."
    if confirm "Create it now?" y; then
      mkdir -p "$MUSIC_PATH" 2>/dev/null || sudo mkdir -p "$MUSIC_PATH" ||
        warn "Couldn't create it; create it yourself before starting the server."
    fi
  fi
else
  # An empty folder keeps the compose mount valid.
  mkdir -p ./music
fi

# ---------------------------------------------------------------------------
section "Accounts"
info "Recommended: leave this to the desktop app. A new server prints a one-time"
info "setup code to its logs, which you enter in the app to create the admin."
ADMIN_USERNAME="" ADMIN_PASSWORD=""
if confirm "Create a local admin account from this file instead?" n; then
  ask_valid ADMIN_USERNAME "Admin username" '^[A-Za-z0-9_.@-]{1,48}$' \
    "Use letters, numbers, dots, dashes, underscores or @." admin
  for _ in 1 2 3; do
    ask_secret ADMIN_PASSWORD "Admin password (at least 10 characters)"
    ask_secret ADMIN_PASSWORD2 "Repeat the password"
    if [ "${#ADMIN_PASSWORD}" -lt 10 ]; then
      warn "That's shorter than 10 characters."
    elif [ "$ADMIN_PASSWORD" != "$ADMIN_PASSWORD2" ]; then
      warn "The passwords don't match."
    else
      break
    fi
    ADMIN_PASSWORD=""
  done
  [ -n "$ADMIN_PASSWORD" ] || fail "no valid admin password was entered"
fi

SIGNUP_MODE="closed" SIGNUP_INVITE_CODE=""
if confirm "Let people create their own accounts (a sign-up page at https://$DOMAIN)?" n; then
  if confirm "Require an invite code? (recommended for a server on the internet)" y; then
    SIGNUP_MODE="invite"
    default_code=$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom 2>/dev/null | head -c 10 || true)
    ask_valid SIGNUP_INVITE_CODE "Invite code to share with friends" '^[A-Za-z0-9_-]{6,64}$' \
      "Use 6-64 letters, numbers, dashes or underscores." "${default_code:-change-me-123}"
  else
    SIGNUP_MODE="open"
  fi
fi

# ---------------------------------------------------------------------------
section "Single sign-on (optional)"
OIDC_ISSUER="" OIDC_CLIENT_ID="" OIDC_CLIENT_SECRET="" OIDC_NAME="" OIDC_ALLOWED_GROUPS="" OIDC_ADMIN_GROUPS=""
if confirm "Sign in with an OIDC provider such as Authentik?" n; then
  info "In your provider, create an OAuth2/OpenID application with this redirect URI:"
  info "  ${BOLD}$PUBLIC_URL/api/auth/oidc/callback${RESET}"
  ask_valid OIDC_ISSUER "Issuer URL" '^https?://' \
    "Use the provider's issuer URL, e.g. https://auth.example.com/application/o/music/"
  ask_valid OIDC_CLIENT_ID "Client ID" '.+' "The client ID can't be empty."
  ask_secret OIDC_CLIENT_SECRET "Client secret (leave empty for a public client)"
  ask OIDC_NAME "Sign-in button label" Authentik
  ask OIDC_ALLOWED_GROUPS "Only allow these groups (comma-separated, empty = anyone)" ""
  ask OIDC_ADMIN_GROUPS "Groups whose members become admins (optional)" ""
fi

# ---------------------------------------------------------------------------
section "Spotify (optional)"
SPOTIFY_CLIENT_ID=""
if confirm "Share a Spotify app ID with everyone who uses this server?" n; then
  info "Create an app at developer.spotify.com/dashboard with the redirect URI"
  info "  ${BOLD}http://127.0.0.1:43821/callback${RESET} and enable Web API + Web Playback SDK."
  ask_valid SPOTIFY_CLIENT_ID "Spotify Client ID" '^[0-9a-fA-F]{32}$' \
    "The client ID is 32 letters and numbers, shown on the app's page."
fi

# ---------------------------------------------------------------------------
section "Apple Music (optional)"
APPLE_MUSIC_TEAM_ID="" APPLE_MUSIC_KEY_ID="" APPLE_MUSIC_PRIVATE_KEY=""
info "Needs an Apple Developer Program membership and a MusicKit key (.p8)."
if confirm "Set up Apple Music now?" n; then
  ask_valid APPLE_MUSIC_TEAM_ID "Apple Team ID" '^[A-Z0-9]{10}$' "The Team ID is 10 letters/numbers."
  ask_valid APPLE_MUSIC_KEY_ID "MusicKit Key ID" '^[A-Z0-9]{10}$' "The Key ID is 10 letters/numbers."
  ask_valid P8_PATH "Path to the AuthKey_XXXXXXXXXX.p8 file" '.+' "Enter the path to the .p8 file."
  [ -r "$P8_PATH" ] || fail "can't read $P8_PATH"
  grep -q "BEGIN PRIVATE KEY" "$P8_PATH" || fail "$P8_PATH doesn't look like a MusicKit key"
  # Store inline with literal \n line breaks; the server turns them back into newlines.
  APPLE_MUSIC_PRIVATE_KEY=$(awk 'BEGIN { ORS = "\\n" } { sub(/\r$/, ""); print }' "$P8_PATH")
fi

# ---------------------------------------------------------------------------
section "AI DJ (optional)"
info "The AI DJ can run its language model on this server (with Ollama in"
info "Docker), so phones and computers don't need Ollama or an API key."
OLLAMA_PROFILE="" OLLAMA_MODEL=""
if confirm "Run the AI DJ on this server?" n; then
  OLLAMA_PROFILE="ollama" model_default="llama3.2:3b"
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
    info "Found an NVIDIA GPU. Using it needs the NVIDIA Container Toolkit."
    if confirm "Use the GPU?" y; then OLLAMA_PROFILE="ollama-gpu" model_default="llama3.1:8b"; fi
  else
    info "No NVIDIA GPU found, so it runs on the CPU: a small model works best."
  fi
  ask_valid OLLAMA_MODEL "Model (from ollama.com/library)" '^[A-Za-z0-9_.:/-]{1,200}$'     "Enter a model name such as llama3.2:3b." "$model_default"
  info "The server downloads it on first start; that can take a few minutes."
fi

# ---------------------------------------------------------------------------
section "Writing $ENV_FILE"
umask 077
{
  echo "# Generated by setup.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Re-run setup.sh to change it."
  echo "MUSIC_PATH=$(envq "$MUSIC_PATH")"
  echo "HOST_PORT=$(envq "$HOST_PORT")"
  echo "PUBLIC_URL=$(envq "$PUBLIC_URL")"
  profiles="${BUNDLED_HTTPS:+https}"
  if [ -n "$OLLAMA_PROFILE" ]; then profiles="${profiles:+$profiles,}$OLLAMA_PROFILE"; fi
  if [ -n "$profiles" ]; then echo "COMPOSE_PROFILES=$(envq "$profiles")"; fi
  echo "SCAN_INTERVAL_MINUTES='60'"
  echo "LOG_LEVEL='info'"
  echo "SIGNUP_MODE=$(envq "$SIGNUP_MODE")"
  if [ -n "$SIGNUP_INVITE_CODE" ]; then echo "SIGNUP_INVITE_CODE=$(envq "$SIGNUP_INVITE_CODE")"; fi
  if [ -n "$ADMIN_USERNAME" ]; then
    echo "ADMIN_USERNAME=$(envq "$ADMIN_USERNAME")"
    echo "ADMIN_PASSWORD=$(envq "$ADMIN_PASSWORD")"
  fi
  if [ -n "$OIDC_ISSUER" ]; then
    echo "OIDC_ISSUER=$(envq "$OIDC_ISSUER")"
    echo "OIDC_CLIENT_ID=$(envq "$OIDC_CLIENT_ID")"
    if [ -n "$OIDC_CLIENT_SECRET" ]; then echo "OIDC_CLIENT_SECRET=$(envq "$OIDC_CLIENT_SECRET")"; fi
    echo "OIDC_NAME=$(envq "$OIDC_NAME")"
    if [ -n "$OIDC_ALLOWED_GROUPS" ]; then echo "OIDC_ALLOWED_GROUPS=$(envq "$OIDC_ALLOWED_GROUPS")"; fi
    if [ -n "$OIDC_ADMIN_GROUPS" ]; then echo "OIDC_ADMIN_GROUPS=$(envq "$OIDC_ADMIN_GROUPS")"; fi
  fi
  if [ -n "$SPOTIFY_CLIENT_ID" ]; then
    echo "SPOTIFY_CLIENT_ID=$(envq "$SPOTIFY_CLIENT_ID")"
  fi
  if [ -n "$OLLAMA_PROFILE" ]; then
    echo "OLLAMA_URL='http://ollama:11434'"
    echo "OLLAMA_MODEL=$(envq "$OLLAMA_MODEL")"
  fi
  if [ -n "$APPLE_MUSIC_TEAM_ID" ]; then
    echo "APPLE_MUSIC_TEAM_ID=$(envq "$APPLE_MUSIC_TEAM_ID")"
    echo "APPLE_MUSIC_KEY_ID=$(envq "$APPLE_MUSIC_KEY_ID")"
    echo "APPLE_MUSIC_PRIVATE_KEY=$(envq "$APPLE_MUSIC_PRIVATE_KEY")"
  fi
} >"$ENV_FILE"
info "Wrote $ENV_FILE (readable only by you)."

# ---------------------------------------------------------------------------
if [ -n "$BUNDLED_HTTPS" ]; then
  section "HTTPS"
  printf '%s {\n\tencode zstd gzip\n\treverse_proxy server:8787\n}\n' "$DOMAIN" >Caddyfile
  info "Wrote Caddyfile. Cadence's own Caddy fetches the certificate when it starts."
  info "Before starting, point $DOMAIN's DNS (an A record) at this machine's IP"
  info "and make sure ports 80 and 443 are open in your firewall."
else
  section "Reverse proxy"
  info "Add this to your Caddyfile and reload Caddy (it fetches the certificate):"
  printf '\n%s%s {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:%s\n}%s\n' "$DIM" "$DOMAIN" "$HOST_PORT" "$RESET"
  info "Using nginx or Traefik instead? Proxy https://$DOMAIN to 127.0.0.1:$HOST_PORT."
fi

# ---------------------------------------------------------------------------
if command -v docker >/dev/null 2>&1 && confirm "Build and start the server now?" y; then
  section "Starting"
  "${DOCKER[@]}" compose up -d --build
  info "Waiting for the server to answer..."
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$HOST_PORT/api/health" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  if curl -fsS "http://127.0.0.1:$HOST_PORT/api/health" >/dev/null 2>&1; then
    info "The server is running."
    code_line=$("${DOCKER[@]}" compose logs server 2>/dev/null | grep -m1 "setup code" || true)
    if [ -n "$code_line" ]; then
      printf '\n  %s%s%s\n' "$BOLD" "${code_line#*| }" "$RESET"
      info "Open https://$DOMAIN/app (or the desktop app) and enter that code to create your admin account."
    fi
  else
    warn "The server didn't answer yet. Check: docker compose logs server"
  fi
else
  section "Next steps"
  info "Start the server:   docker compose up -d --build"
  info "Find the setup code: docker compose logs server | grep \"setup code\""
fi

printf '\n%sDone.%s\n' "$BOLD" "$RESET"
info "Web player:  https://$DOMAIN/app"
info "Admin panel: https://$DOMAIN/admin"
info "Windows app: https://github.com/Hornet-Linux/cadence-music/releases/latest"
