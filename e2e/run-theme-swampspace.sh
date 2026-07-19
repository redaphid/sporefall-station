#!/usr/bin/env bash
# Sporefall Station proof: build, serve on an ephemeral port, screenshot the
# swampspace theme via the ?theme= URL param AND the settings picker.
# Serves on its OWN port (never 5173/4173) and verifies OUR server answered.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4988}"
export BASE_URL="http://localhost:${PORT}"

pnpm exec vite build

pnpm exec vite preview --port "$PORT" --strictPort >/tmp/theme-swampspace-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  # If OUR server died (e.g. the port is squatted by another agent's preview),
  # fail loudly instead of silently testing whatever else answers on the port.
  if ! kill -0 "$SERVER" 2>/dev/null; then
    echo "[run-theme-swampspace] preview server failed to start (port ${PORT} busy?):" >&2
    cat /tmp/theme-swampspace-preview.log >&2
    exit 1
  fi
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

node e2e/theme-swampspace.mjs
