#!/usr/bin/env bash
# #51 annotation + selection overlay screenshot e2e: build, serve the real pixi
# bundle, draw every annotation variety over the committed `comm-scene` world,
# tap-select an entity, assert legibility on the live DOM, and emit stills + an
# mp4. Serves on its OWN port (never 5173/4173-of-another-run).
#
#   ./e2e/run-comm-ui.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4892}"
export BASE_URL="http://localhost:${PORT}"
export E2E_OUT="${E2E_OUT:-e2e/output}"

echo "[comm-ui] building…"
npx vite build >/dev/null

echo "[comm-ui] serving on :${PORT}…"
npx vite preview --port "$PORT" --strictPort >/tmp/e2e-comm-ui-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

if ! command -v ffmpeg >/dev/null; then
  echo "[comm-ui] WARNING: ffmpeg not found — screenshots still run; the mp4 mux will be skipped" >&2
fi

node e2e/comm-ui.mjs
