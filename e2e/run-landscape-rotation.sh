#!/usr/bin/env bash
# Landscape-always e2e: build, serve the real bundle on its OWN port, and drive
# real CDP touch at a real portrait viewport to prove the input mapping rotates
# with the view (see landscape-rotation.mjs for what is asserted and why).
#
# OWN-SERVER VERIFICATION: port squatting has bitten multiple agents — a stale
# preview on the same port silently serves someone else's bundle. Unique port
# with --strictPort AND proof that the responding server serves THIS checkout's
# dist/ (the hashed bundle name in the served HTML must exist locally).
#
#   ./e2e/run-landscape-rotation.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4931}"
export BASE_URL="http://localhost:${PORT}"
export E2E_OUT="${E2E_OUT:-e2e/output}"

echo "[landscape] building…"
npx vite build >/dev/null

echo "[landscape] serving on :${PORT}…"
npx vite preview --port "$PORT" --strictPort >/tmp/e2e-landscape-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

if ! kill -0 "$SERVER" 2>/dev/null; then
  echo "[landscape] FATAL: preview server exited — port ${PORT} squatted? (see /tmp/e2e-landscape-preview.log)" >&2
  exit 1
fi
BUNDLE=$(curl -s "$BASE_URL/" | grep -o 'assets/index-[^"]*\.js' | head -1 || true)
if [ -z "$BUNDLE" ] || [ ! -f "dist/$BUNDLE" ]; then
  echo "[landscape] FATAL: server on :${PORT} does not serve this checkout's dist/ (bundle='${BUNDLE}')" >&2
  exit 1
fi

echo "[landscape] driving touch…"
node e2e/landscape-rotation.mjs
