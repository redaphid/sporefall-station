#!/usr/bin/env bash
# Parity M7 proof: build, serve on an ephemeral port, drive the relationships
# scenario in a real browser (real keyboard), assert a witnessed crime flips
# cops hostile while an unrelated faction stays neutral. Own port (never 5173/4173).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4895}"
export BASE_URL="http://localhost:${PORT}"

pnpm exec vite build

pnpm exec vite preview --port "$PORT" --strictPort >/tmp/parity-rel-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

node e2e/rel-session.mjs
