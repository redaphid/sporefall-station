#!/usr/bin/env bash
# Backbuffer shader-FX proof: build, serve on an ephemeral port, record the four
# feature videos (grenade shockwave+bloom, heat shimmer, max-stack feedback
# trail, exit-portal idle) plus the fx=off control still, then run the headless
# perf comparison. Serves on its OWN port (never 5173/4173).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4972}"
export BASE_URL="http://localhost:${PORT}"

pnpm exec vite build

pnpm exec vite preview --port "$PORT" --strictPort >/tmp/shader-fx-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

node e2e/feature-shader-fx.mjs
node scripts/test/shaderfx-perf.mjs
