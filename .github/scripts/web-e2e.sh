#!/usr/bin/env bash
# Run the web player end-to-end test against the built server image.
set -euo pipefail

IMAGE="${1:-cadence-server:ci}"
PORT=18788
NAME=cadence-web-e2e
MUSIC_DIR="$(mktemp -d)"
PW_DIR="$(mktemp -d)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export SHOTS="${SHOTS:-$PWD/web-screenshots}"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "---- container logs ----"
    docker logs "$NAME" 2>&1 | tail -50 || true
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$MUSIC_DIR" "$PW_DIR"
  exit "$status"
}
trap cleanup EXIT

# A 5-second WAV (8 kHz, mono, 8-bit tone) so playback has time to be observed.
python3 - "$MUSIC_DIR/Smoke Test.wav" <<'PY'
import math, struct, sys
rate, seconds = 8000, 5
samples = bytes(int(128 + 60 * math.sin(2 * math.pi * 440 * i / rate)) for i in range(rate * seconds))
fmt = b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate, 1, 8)
with open(sys.argv[1], "wb") as f:
    f.write(b"RIFF" + struct.pack("<I", 36 + len(samples)) + b"WAVE" + fmt + b"data" + struct.pack("<I", len(samples)) + samples)
PY
chmod 755 "$MUSIC_DIR"; chmod 644 "$MUSIC_DIR"/*

docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8787" \
  -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD=admin-password-123 \
  -e SIGNUP_MODE=open -e SCAN_INTERVAL_MINUTES=0 \
  -v "$MUSIC_DIR:/music:ro" "$IMAGE" >/dev/null
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done

# Playwright with a real Chromium, installed outside the repo.
(cd "$PW_DIR" && npm init -y >/dev/null && npm install --no-audit --no-fund playwright@1.55.0 >/dev/null \
  && npx playwright install --with-deps chromium >/dev/null)
cp "$SCRIPT_DIR/web-e2e.mjs" "$PW_DIR/"
BASE="http://127.0.0.1:$PORT" node "$PW_DIR/web-e2e.mjs"
