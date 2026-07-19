#!/usr/bin/env bash
# Adaptive touch-controls visibility proof: desktop → no sticks; phone → sticks;
# fake pad joins → hidden; touch → back; pad input → hidden; unplug → back.
# Serves the real build on its own port; artifacts land in E2E_OUT.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4941}"
export BASE_URL="http://localhost:${PORT}"
export E2E_OUT="${E2E_OUT:-e2e/output}"

echo "[stick-visibility] building…"
pnpm exec vite build >/dev/null

echo "[stick-visibility] serving on :${PORT}…"
pnpm exec vite preview --port "$PORT" --strictPort >/tmp/e2e-stick-visibility-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

rc=0
node e2e/stick-visibility.mjs || rc=1

echo "[stick-visibility] done. artifacts in $E2E_OUT"
exit "$rc"
