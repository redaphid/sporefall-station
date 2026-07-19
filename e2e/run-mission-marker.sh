#!/usr/bin/env bash
# Mission-marker parity proof: build, serve on an ephemeral port, then record
# the seed-7 "follow the 🎯 to the SE-corner briefcase" clip with rendered-truth
# asserts (see e2e/mission-marker.mjs). Own port (never 5173/4173).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4907}"
export BASE_URL="http://localhost:${PORT}"

pnpm exec vite build

pnpm exec vite preview --port "$PORT" --strictPort >/tmp/mission-marker-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

node e2e/mission-marker.mjs
