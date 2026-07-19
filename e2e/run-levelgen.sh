#!/usr/bin/env bash
# Levelgen-architecture visual evidence: full-level maps (tsx renderer) + the
# annotated tour video (levelgen-tour.mjs). Serves its OWN build on its OWN
# port (4923 — unique across e2e runners) and PROVES the server is this
# build via a nonce file, so a stale preview squatting the port fails loudly
# instead of silently screenshotting someone else's bundle.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4923}"
export BASE_URL="http://localhost:${PORT}"

pnpm exec vite build

NONCE="levelgen-$(date +%s)-$RANDOM"
echo "$NONCE" > dist/levelgen-nonce.txt

pnpm exec vite preview --port "$PORT" --strictPort >/tmp/levelgen-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if ! kill -0 "$SERVER" 2>/dev/null; then
    echo "[run-levelgen] preview server failed to start (port ${PORT} busy?):" >&2
    cat /tmp/levelgen-preview.log >&2
    exit 1
  fi
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

SERVED="$(curl -sf "$BASE_URL/levelgen-nonce.txt" || true)"
if [ "$SERVED" != "$NONCE" ]; then
  echo "[run-levelgen] port ${PORT} is serving a DIFFERENT build (nonce mismatch: got '${SERVED}')" >&2
  exit 1
fi

pnpm exec tsx scripts/test/render-level-maps.mts e2e/output/maps
pnpm exec tsx scripts/test/gen-levelgen-tour.mts e2e/output/tour-fixtures
node e2e/levelgen-tour.mjs
