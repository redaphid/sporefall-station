#!/usr/bin/env bash
# Parity M6 proof: build, serve on an ephemeral port, drive the item-breadth
# scenario in a real browser (real keyboard), assert one item per category
# produces its effect, capture a video and screenshots. Own port (never 5173/4173).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4894}"
export BASE_URL="http://localhost:${PORT}"

pnpm exec vite build

pnpm exec vite preview --port "$PORT" --strictPort >/tmp/parity-items-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

node e2e/items-session.mjs
