#!/usr/bin/env bash
# Combat-AI proof: build, serve on an ephemeral port, drive the npc-combat
# scenario in a real browser, assert acquire/converge/fire/damage, and capture a
# video + screenshots. Own port (never 5173/4173).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4897}"
export BASE_URL="http://localhost:${PORT}"

pnpm exec vite build

pnpm exec vite preview --port "$PORT" --strictPort >/tmp/npc-combat-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

node e2e/npc-combat-session.mjs
