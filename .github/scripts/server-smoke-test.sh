#!/usr/bin/env bash
# Smoke-test the built server image: start it with a generated music file,
# then exercise health, sign-in, a library scan and a ranged stream.
set -euo pipefail

IMAGE="${1:-cadence-server:ci}"
PORT=18787
NAME=uma-smoke
MUSIC_DIR="$(mktemp -d)"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "---- container logs ----"
    docker logs "$NAME" 2>&1 || true
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$MUSIC_DIR"
  exit "$status"
}
trap cleanup EXIT

# A tiny valid WAV file (8 kHz, mono, 8-bit, 800 samples => 844 bytes).
python3 - "$MUSIC_DIR/Smoke Test.wav" <<'PY'
import struct, sys
samples = 800
data = bytes([128]) * samples
header = b"RIFF" + struct.pack("<I", 36 + samples) + b"WAVE"
fmt = b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, 8000, 8000, 1, 8)
with open(sys.argv[1], "wb") as f:
    f.write(header + fmt + b"data" + struct.pack("<I", samples) + data)
PY
chmod 755 "$MUSIC_DIR"
chmod 644 "$MUSIC_DIR"/*

docker run -d --name "$NAME" \
  -p "127.0.0.1:$PORT:8787" \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=smoke-test-password \
  -e SCAN_INTERVAL_MINUTES=0 \
  -v "$MUSIC_DIR:/music:ro" \
  "$IMAGE" >/dev/null

BASE="http://127.0.0.1:$PORT"
echo "Waiting for $BASE/api/health"
for _ in $(seq 1 30); do
  if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "$BASE/api/health" | tee /dev/stderr | jq -e '.ok == true and .auth.password == true' >/dev/null

TOKEN="$(curl -fsS -X POST -H 'content-type: application/json' \
  -d '{"username":"admin","password":"smoke-test-password"}' \
  "$BASE/api/auth/login" | jq -er .token)"
AUTH=(-H "authorization: Bearer $TOKEN")

curl -fsS "${AUTH[@]}" "$BASE/api/me" | jq -e '.username == "admin" and .isAdmin == true' >/dev/null
curl -fsS -X POST "${AUTH[@]}" "$BASE/api/library/scan?wait=1" | jq -e '.total == 1' >/dev/null

TRACK_ID="$(curl -fsS "${AUTH[@]}" "$BASE/api/tracks" | jq -er '.items[0].id')"
STREAM_PATH="$(curl -fsS "${AUTH[@]}" "$BASE/api/tracks/$TRACK_ID/stream-url" | jq -er .path)"

HEADERS="$(curl -fsS -D - -o /dev/null -H 'range: bytes=0-9' "$BASE/$STREAM_PATH")"
echo "$HEADERS" | grep -qi '^HTTP/1.1 206'
echo "$HEADERS" | grep -qi '^content-range: bytes 0-9/844'

# The landing page and the web player are served.
curl -fsS "$BASE/" | grep -q "Cadence"
WEB_INDEX="$(curl -fsS "$BASE/app/")"
echo "$WEB_INDEX" | grep -q 'id="root"'
ASSET="$(echo "$WEB_INDEX" | grep -o '/app/assets/[^"]*\.js' | head -1)"
test -n "$ASSET"
curl -fsS -o /dev/null "$BASE$ASSET"
curl -fsS "$BASE/app/auth/callback" | grep -q 'id="root"'

# Unauthenticated requests are refused.
test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/tracks")" = "401"

# The container reports healthy via its own HEALTHCHECK (first probe runs
# after one 30s interval).
for _ in $(seq 1 75); do
  STATE="$(docker inspect -f '{{.State.Health.Status}}' "$NAME")"
  [ "$STATE" = "healthy" ] && break
  sleep 1
done
test "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = "healthy"

echo "Server smoke test passed"
