#!/usr/bin/env bash
# Object info popup e2e: build, serve the real pixi bundle on its OWN port,
# drive real touch (CDP) + mouse input against the committed `comm-scene`
# world, and emit stills + an mp4 (see inspect-ui.mjs for the assertions).
#
# OWN-SERVER VERIFICATION: port squatting has bitten multiple agents — a stale
# preview on the same port silently serves someone else's bundle. We use a
# unique port with --strictPort AND prove the responding server serves THIS
# checkout's dist/ (the hashed bundle name in the served HTML must exist
# locally) before running the test.
#
#   ./e2e/run-inspect-ui.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4917}"
export BASE_URL="http://localhost:${PORT}"
export E2E_OUT="${E2E_OUT:-e2e/output}"

echo "[inspect-ui] building…"
npx vite build >/dev/null

echo "[inspect-ui] serving on :${PORT}…"
npx vite preview --port "$PORT" --strictPort >/tmp/e2e-inspect-ui-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

# Our server must still be alive (strictPort would have died on a squat)…
if ! kill -0 "$SERVER" 2>/dev/null; then
  echo "[inspect-ui] FATAL: preview server exited — port ${PORT} squatted? (see /tmp/e2e-inspect-ui-preview.log)" >&2
  exit 1
fi
# …and the page it serves must reference a bundle that exists in OUR dist/.
BUNDLE=$(curl -s "$BASE_URL/" | grep -o 'assets/index-[^"]*\.js' | head -1 || true)
if [ -z "$BUNDLE" ] || [ ! -f "dist/$BUNDLE" ]; then
  echo "[inspect-ui] FATAL: server on :${PORT} is not serving this checkout's dist/ (got '$BUNDLE')" >&2
  exit 1
fi
echo "[inspect-ui] verified own server (dist/$BUNDLE)"

if ! command -v ffmpeg >/dev/null; then
  echo "[inspect-ui] WARNING: ffmpeg not found — screenshots still run; the mp4 mux will fail the run" >&2
fi

node e2e/inspect-ui.mjs
