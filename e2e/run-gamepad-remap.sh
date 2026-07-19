#!/usr/bin/env bash
# Gamepad-remap e2e: rebind attack to B through the capture UI, prove the
# overlay changes live firing, survives reload, and resets clean. See
# gamepad-remap.mjs.
#
# OWN-SERVER VERIFICATION: unique port + --strictPort, and the served HTML must
# reference a bundle that exists in THIS checkout's dist/ (port-squatting has
# bitten multiple agents).
#
#   ./e2e/run-gamepad-remap.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4971}"
export BASE_URL="http://localhost:${PORT}"
export E2E_OUT="${E2E_OUT:-e2e/output}"

echo "[gamepad-remap] building…"
pnpm exec vite build >/dev/null

echo "[gamepad-remap] serving on :${PORT}…"
pnpm exec vite preview --port "$PORT" --strictPort >/tmp/e2e-gamepad-remap-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

if ! kill -0 "$SERVER" 2>/dev/null; then
  echo "[gamepad-remap] FATAL: preview server exited — port ${PORT} squatted? (see /tmp/e2e-gamepad-remap-preview.log)" >&2
  exit 1
fi
BUNDLE=$(curl -s "$BASE_URL/" | grep -o 'assets/index-[^"]*\.js' | head -1 || true)
if [ -z "$BUNDLE" ] || [ ! -f "dist/$BUNDLE" ]; then
  echo "[gamepad-remap] FATAL: server on :${PORT} is not serving this checkout's dist/ (got '$BUNDLE')" >&2
  exit 1
fi
echo "[gamepad-remap] verified own server (dist/$BUNDLE)"

node e2e/gamepad-remap.mjs
