#!/usr/bin/env bash
# Settings-gear touch e2e: prove the gear is tappable on a phone (real CDP
# touches, stick zones live), the panel + theme picker work, and the press-
# exempt chrome layer steals nothing from inspect/sticks. See settings-gear.mjs.
#
# OWN-SERVER VERIFICATION: unique port + --strictPort, and the served HTML must
# reference a bundle that exists in THIS checkout's dist/ (port-squatting has
# bitten multiple agents).
#
#   ./e2e/run-settings-gear.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4963}"
export BASE_URL="http://localhost:${PORT}"
export E2E_OUT="${E2E_OUT:-e2e/output}"

echo "[settings-gear] building…"
pnpm exec vite build >/dev/null

echo "[settings-gear] serving on :${PORT}…"
pnpm exec vite preview --port "$PORT" --strictPort >/tmp/e2e-settings-gear-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

if ! kill -0 "$SERVER" 2>/dev/null; then
  echo "[settings-gear] FATAL: preview server exited — port ${PORT} squatted? (see /tmp/e2e-settings-gear-preview.log)" >&2
  exit 1
fi
BUNDLE=$(curl -s "$BASE_URL/" | grep -o 'assets/index-[^"]*\.js' | head -1 || true)
if [ -z "$BUNDLE" ] || [ ! -f "dist/$BUNDLE" ]; then
  echo "[settings-gear] FATAL: server on :${PORT} is not serving this checkout's dist/ (got '$BUNDLE')" >&2
  exit 1
fi
echo "[settings-gear] verified own server (dist/$BUNDLE)"

node e2e/settings-gear.mjs
