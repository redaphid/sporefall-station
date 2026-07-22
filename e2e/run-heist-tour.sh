#!/usr/bin/env bash
# Heist-finale visual evidence: the three-beat tour video (heist-tour.mjs).
# Serves its OWN build on its OWN port (4933 — unique across e2e runners) and
# PROVES the server is this build via a nonce file, so a stale preview
# squatting the port fails loudly instead of silently recording another bundle.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4933}"
export BASE_URL="http://localhost:${PORT}"

pnpm exec vite build

NONCE="heist-$(date +%s)-$RANDOM"
echo "$NONCE" > dist/heist-nonce.txt

pnpm exec vite preview --port "$PORT" --strictPort >/tmp/heist-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if ! kill -0 "$SERVER" 2>/dev/null; then
    echo "[run-heist-tour] preview server failed to start (port ${PORT} busy?):" >&2
    cat /tmp/heist-preview.log >&2
    exit 1
  fi
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

SERVED="$(curl -sf "$BASE_URL/heist-nonce.txt" || true)"
if [ "$SERVED" != "$NONCE" ]; then
  echo "[run-heist-tour] port ${PORT} is serving a DIFFERENT build (nonce mismatch: got '${SERVED}')" >&2
  exit 1
fi

pnpm exec tsx scripts/test/gen-heist-tour.mts e2e/output/heist-fixtures
node e2e/heist-tour.mjs
