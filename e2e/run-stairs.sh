#!/usr/bin/env bash
# Stairs e2e: walk up into the loft, smash its cache, walk back down.
# See stairs.mjs.
#
# OWN-SERVER VERIFICATION: unique port + --strictPort, and the served HTML must
# reference a bundle that exists in THIS checkout's dist/.
#
#   ./e2e/run-stairs.sh   (E2E_OUT=dir to redirect screenshots)
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4979}"
export BASE_URL="http://localhost:${PORT}"
export E2E_OUT="${E2E_OUT:-e2e/output}"

echo "[stairs] building…"
pnpm exec vite build >/dev/null

echo "[stairs] serving on :${PORT}…"
pnpm exec vite preview --port "$PORT" --strictPort >/tmp/e2e-stairs-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done
if ! kill -0 "$SERVER" 2>/dev/null; then
  echo "[stairs] FATAL: preview server exited — port ${PORT} squatted? (see /tmp/e2e-stairs-preview.log)" >&2
  exit 1
fi
BUNDLE=$(curl -s "$BASE_URL/" | grep -o 'assets/index-[^"]*\.js' | head -1 || true)
if [ -z "$BUNDLE" ] || [ ! -f "dist/$BUNDLE" ]; then
  echo "[stairs] FATAL: server on :${PORT} is not serving this checkout's dist/ (got '$BUNDLE')" >&2
  exit 1
fi
echo "[stairs] verified own server (dist/$BUNDLE)"

STAIRS_NO_GPU="${STAIRS_NO_GPU-1}" node e2e/stairs.mjs
