#!/usr/bin/env bash
# Indoor complex (floors 3+) screenshots + video. Serves its OWN build on its
# OWN port (4931) and proves the server is this build via a nonce file.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4931}"
export BASE_URL="http://localhost:${PORT}"

pnpm exec vite build

NONCE="indoor-$(date +%s)-$RANDOM"
echo "$NONCE" > dist/indoor-nonce.txt

pnpm exec vite preview --port "$PORT" --strictPort >/tmp/indoor-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if ! kill -0 "$SERVER" 2>/dev/null; then
    echo "[run-indoor-complex] preview server failed to start (port ${PORT} busy?):" >&2
    cat /tmp/indoor-preview.log >&2
    exit 1
  fi
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

SERVED="$(curl -sf "$BASE_URL/indoor-nonce.txt" || true)"
if [ "$SERVED" != "$NONCE" ]; then
  echo "[run-indoor-complex] port ${PORT} is serving a DIFFERENT build (nonce mismatch: got '${SERVED}')" >&2
  exit 1
fi

pnpm exec tsx scripts/test/gen-indoor-tour.mts e2e/output/indoor-fixtures
node e2e/indoor-complex.mjs
