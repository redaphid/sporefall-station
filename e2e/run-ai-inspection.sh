#!/usr/bin/env bash
# window.backseat inspection-surface e2e: build, serve the real bundle on its
# OWN port, and drive the page purely via the console surface (see
# ai-inspection.mjs) — with and without ?debug, plus the ?e2e legacy aliases.
#
# OWN-SERVER VERIFICATION: a stale preview squatting the port silently serves
# someone else's bundle. Unique port + --strictPort AND prove the responding
# server serves THIS checkout's dist/ before testing.
#
#   ./e2e/run-ai-inspection.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4977}"
export BASE_URL="http://localhost:${PORT}"

echo "[ai-inspection] building…"
npx vite build >/dev/null

echo "[ai-inspection] serving on :${PORT}…"
npx vite preview --port "$PORT" --strictPort >/tmp/e2e-ai-inspection-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

if ! kill -0 "$SERVER" 2>/dev/null; then
  echo "[ai-inspection] FATAL: preview server exited — port ${PORT} squatted? (see /tmp/e2e-ai-inspection-preview.log)" >&2
  exit 1
fi
BUNDLE=$(curl -s "$BASE_URL/" | grep -o 'assets/index-[^"]*\.js' | head -1 || true)
if [ -z "$BUNDLE" ] || [ ! -f "dist/$BUNDLE" ]; then
  echo "[ai-inspection] FATAL: server on :${PORT} is not serving this checkout's dist/ (got '$BUNDLE')" >&2
  exit 1
fi
echo "[ai-inspection] verified own server (dist/$BUNDLE)"

node e2e/ai-inspection.mjs
