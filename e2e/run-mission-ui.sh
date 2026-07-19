#!/usr/bin/env bash
# Mission-UI feature proof: build, serve on an ephemeral port, then record the
# three deterministic mission-panel clips (hyperlink pan, progress states,
# degenerate states) with per-state screenshots. Own port (never 5173/4173).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4893}"
export BASE_URL="http://localhost:${PORT}"

pnpm exec vite build

pnpm exec vite preview --port "$PORT" --strictPort >/tmp/mission-ui-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

node e2e/mission-ui.mjs
