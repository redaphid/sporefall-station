#!/usr/bin/env bash
# Parity M4 proof: build, serve on an ephemeral port, drive the frost +
# wet-electric interaction scenarios in a real browser, assert shatter + chain,
# capture a video and screenshots. Serves on its OWN port (never 5173/4173).
#
# Headless by default. `E2E_HEADFUL=1` runs it headed, and `E2E_CDP=<devtools
# url>` drives an already-running headed browser instead - the path that works
# on a WSL2 box whose WSLg is wedged. See acquireBrowser in e2e/lib.mjs.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4892}"
export BASE_URL="http://localhost:${PORT}"

pnpm exec vite build

pnpm exec vite preview --port "$PORT" --strictPort >/tmp/parity-frost-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

node e2e/frost-session.mjs
