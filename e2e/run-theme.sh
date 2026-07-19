#!/usr/bin/env bash
# Theme hot-swap proof: build, serve on an ephemeral port, screenshot the same
# seeded scene under city vs the magenta test theme (runtime swap), assert the
# pixels changed and nothing crashed. Serves on its OWN port (never 5173/4173).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4981}"
export BASE_URL="http://localhost:${PORT}"

pnpm exec vite build

pnpm exec vite preview --port "$PORT" --strictPort >/tmp/theme-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  # If OUR server died (e.g. the port is squatted by another agent's preview),
  # fail loudly instead of silently testing whatever else answers on the port.
  if ! kill -0 "$SERVER" 2>/dev/null; then
    echo "[run-theme] preview server failed to start (port ${PORT} busy?):" >&2
    cat /tmp/theme-preview.log >&2
    exit 1
  fi
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

node e2e/theme-swap.mjs
