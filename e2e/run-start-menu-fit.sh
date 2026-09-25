#!/usr/bin/env bash
# Start-menu fit e2e: every Solo/Host/Join/Settings button is on screen, hit-
# testable and >= 44px at phone viewports (portrait is rotated to landscape by
# orientation.ts), and desktop is unharmed. See start-menu-fit.mjs.
#
# OWN-SERVER VERIFICATION: unique port + --strictPort, and the served HTML must
# reference a bundle that exists in THIS checkout's dist/ (port-squatting has
# bitten multiple agents).
#
#   ./e2e/run-start-menu-fit.sh   (E2E_OUT=dir to redirect screenshots)
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4977}"
export BASE_URL="http://localhost:${PORT}"
export E2E_OUT="${E2E_OUT:-e2e/output}"

echo "[start-menu-fit] building…"
pnpm exec vite build >/dev/null

echo "[start-menu-fit] serving on :${PORT}…"
pnpm exec vite preview --port "$PORT" --strictPort >/tmp/e2e-start-menu-fit-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

if ! kill -0 "$SERVER" 2>/dev/null; then
  echo "[start-menu-fit] FATAL: preview server exited — port ${PORT} squatted? (see /tmp/e2e-start-menu-fit-preview.log)" >&2
  exit 1
fi
BUNDLE=$(curl -s "$BASE_URL/" | grep -o 'assets/index-[^"]*\.js' | head -1 || true)
if [ -z "$BUNDLE" ] || [ ! -f "dist/$BUNDLE" ]; then
  echo "[start-menu-fit] FATAL: server on :${PORT} is not serving this checkout's dist/ (got '$BUNDLE')" >&2
  exit 1
fi
echo "[start-menu-fit] verified own server (dist/$BUNDLE)"

node e2e/start-menu-fit.mjs
