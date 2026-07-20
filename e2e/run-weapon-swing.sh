#!/usr/bin/env bash
# feat/weapon-sprites — held-weapon SWING + mod-mutation videos. Builds, serves
# the real pixi bundle on its own port, injects melee loadouts (?world=@inline),
# and records an asserted mp4 + stills per cut (plain sledgehammer, plain bat,
# incendiary-modded sledgehammer). Artifacts are copied to E2E_SHARE when set.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4894}"
export BASE_URL="http://localhost:${PORT}"
export E2E_OUT="${E2E_OUT:-e2e/output}"

echo "[weapon-swing] building…"
pnpm exec vite build >/dev/null

echo "[weapon-swing] serving on :${PORT}…"
pnpm exec vite preview --port "$PORT" --strictPort >/tmp/e2e-weapon-swing-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

rc=0
node e2e/feature-weapon-swing.mjs || rc=1

echo "[weapon-swing] done. artifacts in $E2E_OUT"
exit "$rc"
