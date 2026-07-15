#!/usr/bin/env bash
# #53 weapon-mods signature-gun videos + draft/inspect stills. Builds, serves the
# real pixi bundle on its own port, injects modded loadouts (?world=@inline),
# records an asserted mp4 per signature gun, and captures the draft + inspect
# stills. Final PNGs are copied to E2E_SHARE when set.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4893}"
export BASE_URL="http://localhost:${PORT}"
export E2E_OUT="${E2E_OUT:-e2e/output}"

echo "[weapon-mods] building…"
pnpm exec vite build >/dev/null

echo "[weapon-mods] serving on :${PORT}…"
pnpm exec vite preview --port "$PORT" --strictPort >/tmp/e2e-weapon-mods-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

rc=0
node e2e/feature-weapon-mods.mjs || rc=1
node e2e/shots-draft-inspect.mjs || rc=1

echo "[weapon-mods] done. artifacts in $E2E_OUT"
exit "$rc"
