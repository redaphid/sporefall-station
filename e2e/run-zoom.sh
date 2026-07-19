#!/usr/bin/env bash
# Camera zoom e2e (pinch + scrollwheel): build, serve the real bundle, then run
# zoom-session.mjs — wheel zoom in/out during scripted play, tap-to-inspect at
# three zoom levels, min/default/max stills, and a real synthesized two-finger
# pinch. Serves on its OWN port.
#
#   ./e2e/run-zoom.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4894}"
export BASE_URL="http://localhost:${PORT}"
export E2E_OUT="${E2E_OUT:-e2e/output}"

echo "[zoom] building…"
npx vite build >/dev/null

echo "[zoom] serving on :${PORT}…"
npx vite preview --port "$PORT" --strictPort >/tmp/e2e-zoom-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

if ! command -v ffmpeg >/dev/null; then
  echo "[zoom] WARNING: ffmpeg not found — the mp4 mux will fail" >&2
fi

node e2e/zoom-session.mjs
