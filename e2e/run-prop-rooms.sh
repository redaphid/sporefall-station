#!/usr/bin/env bash
# Prop-art lineup: build, serve on a private port, generate the fixture, shoot.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-4939}"
export BASE_URL="http://localhost:${PORT}"
pnpm exec vite build
NONCE="roomshot-$(date +%s)-$RANDOM"
echo "$NONCE" > dist/roomshot-nonce.txt
pnpm exec vite preview --port "$PORT" --strictPort >/tmp/roomshot-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  if ! kill -0 "$SERVER" 2>/dev/null; then echo "preview died:"; cat /tmp/roomshot-preview.log; exit 1; fi
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done
SERVED="$(curl -sf "$BASE_URL/roomshot-nonce.txt" || true)"
[ "$SERVED" = "$NONCE" ] || { echo "port ${PORT} serving a DIFFERENT build (got '${SERVED}')"; exit 1; }
pnpm exec tsx scripts/test/gen-prop-rooms.mts e2e/output/prop-rooms
node e2e/prop-room-shots.mjs
