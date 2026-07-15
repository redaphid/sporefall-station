#!/usr/bin/env bash
# Parity M3 fire proof: build, serve on an ephemeral port, drive the
# ?scenario=fire demo in a real browser, assert spread + burn DoT, capture a
# video and screenshots. Serves on its OWN port (never 5173/4173).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4890}"
export BASE_URL="http://localhost:${PORT}"

pnpm exec vite build

pnpm exec vite preview --port "$PORT" --strictPort >/tmp/parity-fire-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

node e2e/fire-session.mjs
