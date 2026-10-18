#!/usr/bin/env bash
# One-line installer for the Cadence server:
#
#   curl -fsSL https://raw.githubusercontent.com/Hornet-Linux/cadence-music/main/deploy/install.sh | bash
#
# Installs Docker if it's missing (with your OK), downloads Cadence to
# ~/cadence-music and runs the setup wizard. Run it again later to update.
set -euo pipefail

REPO="https://github.com/Hornet-Linux/cadence-music.git"
DIR="${CADENCE_DIR:-$HOME/cadence-music}"

say() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
die() { printf '\033[33mInstall stopped:\033[0m %s\n' "$*" >&2; exit 1; }

# The script itself arrives on stdin, so questions are read from the terminal.
[ -r /dev/tty ] || die "run this from an interactive terminal."
confirm() {
  local reply
  printf '\033[1m%s\033[0m [Y/n]: ' "$1" >/dev/tty
  IFS= read -r reply </dev/tty || true
  [[ ${reply:-y} =~ ^[Yy] ]]
}

[ "$(uname -s)" = Linux ] || die "the server runs on Linux (a VPS or home server). On Windows, just install the desktop app."

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "run as root or install sudo."
  SUDO="sudo"
fi

# Basic tools.
missing=()
for tool in git curl; do command -v "$tool" >/dev/null 2>&1 || missing+=("$tool"); done
if [ ${#missing[@]} -gt 0 ]; then
  say "Installing ${missing[*]}"
  if command -v apt-get >/dev/null 2>&1; then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq "${missing[@]}"
  elif command -v dnf >/dev/null 2>&1; then $SUDO dnf install -y -q "${missing[@]}"
  else die "please install ${missing[*]} and run this again."
  fi
fi

# Docker with the compose plugin.
have_compose() { docker compose version >/dev/null 2>&1 || $SUDO docker compose version >/dev/null 2>&1; }
if ! command -v docker >/dev/null 2>&1 || ! have_compose; then
  say "Cadence runs in Docker, which isn't installed yet."
  confirm "Install Docker now using Docker's official script (get.docker.com)?" || die "install Docker, then run this again."
  curl -fsSL https://get.docker.com | $SUDO sh
fi

# Download or update.
if [ -d "$DIR/.git" ]; then
  say "Updating $DIR"
  git -C "$DIR" pull --ff-only
else
  say "Downloading Cadence to $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR/deploy"
if [ -f .env ]; then
  say "Already set up: rebuilding with the latest version"
  if docker info >/dev/null 2>&1; then docker compose up -d --build; else $SUDO docker compose up -d --build; fi
  say "Updated. To change settings, run: $DIR/deploy/setup.sh"
else
  bash ./setup.sh </dev/tty
fi
