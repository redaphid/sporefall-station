#!/usr/bin/env bash
# feat/sprite-scale-8dir showcase: 48px characters walking a full compass
# circle — one still per facing (8) plus an asserted mp4. Builds, serves the
# real pixi bundle on its own port, injects the walk8 stage (?world=@inline),
# and records. Artifacts land in E2E_OUT (and E2E_SHARE when set).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4917}"
export BASE_URL="http://localhost:${PORT}"
export E2E_OUT="${E2E_OUT:-e2e/output}"

echo "[walk8] building…"
pnpm exec vite build >/dev/null

echo "[walk8] serving on :${PORT}…"
pnpm exec vite preview --port "$PORT" --strictPort >/tmp/e2e-walk8-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

# If OUR preview died (e.g. the port was already taken by a stale server from
# another session), abort loudly — recording against someone else's bundle
# produces maddening ghost failures.
if ! kill -0 "$SERVER" 2>/dev/null; then
  echo "[walk8] preview failed to start (port ${PORT} busy?) — see /tmp/e2e-walk8-preview.log" >&2
  exit 1
fi

rc=0
node e2e/feature-walk8.mjs || rc=1

echo "[walk8] done. artifacts in $E2E_OUT"
exit "$rc"
