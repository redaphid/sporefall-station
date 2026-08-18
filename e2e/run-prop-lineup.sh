#!/usr/bin/env bash
# Prop-art lineup: build, serve on a private port, generate the fixture, shoot.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-4937}"
export BASE_URL="http://localhost:${PORT}"
pnpm exec vite build
NONCE="lineup-$(date +%s)-$RANDOM"
echo "$NONCE" > dist/lineup-nonce.txt
pnpm exec vite preview --port "$PORT" --strictPort >/tmp/lineup-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  if ! kill -0 "$SERVER" 2>/dev/null; then echo "preview died:"; cat /tmp/lineup-preview.log; exit 1; fi
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done
SERVED="$(curl -sf "$BASE_URL/lineup-nonce.txt" || true)"
[ "$SERVED" = "$NONCE" ] || { echo "port ${PORT} serving a DIFFERENT build (got '${SERVED}')"; exit 1; }
pnpm exec tsx scripts/test/gen-prop-lineup.mts e2e/output/prop-lineup
node e2e/prop-lineup-shots.mjs
