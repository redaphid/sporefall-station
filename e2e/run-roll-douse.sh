#!/usr/bin/env bash
# #roll-douses-fire stop-drop-and-roll headline video. Builds, serves the real
# pixi bundle on its own port, injects the ablaze duel-lane world
# (?world=@inline), and records asserted mp4s + stills for the two-roll douse
# and its no-roll control burnout. Artifacts land in E2E_OUT (and E2E_SHARE
# when set).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4993}"
export BASE_URL="http://localhost:${PORT}"
export E2E_OUT="${E2E_OUT:-e2e/output}"

echo "[roll-douse] building…"
pnpm exec vite build >/dev/null

echo "[roll-douse] serving on :${PORT}…"
pnpm exec vite preview --port "$PORT" --strictPort >/tmp/e2e-roll-douse-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

# Own-server check: make sure THIS run's preview answers, not a stale neighbor.
if ! curl -sf -o /dev/null "$BASE_URL/"; then
  echo "[roll-douse] preview server on :${PORT} never came up" >&2
  exit 1
fi
if ! kill -0 "$SERVER" 2>/dev/null; then
  echo "[roll-douse] :${PORT} is answering but our server died — another process owns the port" >&2
  exit 1
fi

rc=0
node e2e/feature-roll-douse.mjs || rc=1

echo "[roll-douse] done. artifacts in $E2E_OUT"
exit "$rc"
