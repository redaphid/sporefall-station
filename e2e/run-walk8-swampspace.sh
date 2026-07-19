#!/usr/bin/env bash
# Character-consistency proof: the swampspace vine-ranger walking a full
# compass circle — one still per facing (8) plus an asserted mp4. Serves the
# real pixi bundle on its OWN port and verifies OUR server answered before
# recording (a stale server from another session produces ghost failures).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4923}"
export BASE_URL="http://localhost:${PORT}"
export E2E_OUT="${E2E_OUT:-e2e/output}"

echo "[walk8-swampspace] building…"
pnpm exec vite build >/dev/null

echo "[walk8-swampspace] serving on :${PORT}…"
pnpm exec vite preview --port "$PORT" --strictPort >/tmp/e2e-walk8-swampspace-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if ! kill -0 "$SERVER" 2>/dev/null; then
    echo "[walk8-swampspace] preview failed to start (port ${PORT} busy?):" >&2
    cat /tmp/e2e-walk8-swampspace-preview.log >&2
    exit 1
  fi
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

rc=0
node e2e/feature-walk8-swampspace.mjs || rc=1

echo "[walk8-swampspace] done. artifacts in $E2E_OUT"
exit "$rc"
