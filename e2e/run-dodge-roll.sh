#!/usr/bin/env bash
# #54 dodge-roll headline video. Builds, serves the real pixi bundle on its own
# port, injects the duel world (?world=@inline), and records an asserted mp4 +
# stills for the roll-through-bullet headline and its no-roll control. Final
# artifacts are copied to E2E_SHARE when set.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4894}"
export BASE_URL="http://localhost:${PORT}"
export E2E_OUT="${E2E_OUT:-e2e/output}"

echo "[dodge-roll] building…"
pnpm exec vite build >/dev/null

echo "[dodge-roll] serving on :${PORT}…"
pnpm exec vite preview --port "$PORT" --strictPort >/tmp/e2e-dodge-roll-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

rc=0
node e2e/feature-dodge-roll.mjs || rc=1

echo "[dodge-roll] done. artifacts in $E2E_OUT"
exit "$rc"
