#!/usr/bin/env bash
# feat/rotoscoped-walk showcase: the swampspace vine-ranger walking a full
# compass circle on its 8-frame rotoscoped walk cycles — one still per facing
# plus an asserted mp4. Own port + own-server check (recording against a stale
# preview from another session produces ghost failures).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4993}"
export BASE_URL="http://localhost:${PORT}"
export E2E_OUT="${E2E_OUT:-e2e/output}"

echo "[roto-walk] building…"
pnpm exec vite build >/dev/null

echo "[roto-walk] serving on :${PORT}…"
pnpm exec vite preview --port "$PORT" --strictPort >/tmp/e2e-roto-walk-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

if ! kill -0 "$SERVER" 2>/dev/null; then
  echo "[roto-walk] preview failed to start (port ${PORT} busy?) — see /tmp/e2e-roto-walk-preview.log" >&2
  exit 1
fi

rc=0
node e2e/feature-roto-walk.mjs || rc=1

echo "[roto-walk] done. artifacts in $E2E_OUT"
exit "$rc"
