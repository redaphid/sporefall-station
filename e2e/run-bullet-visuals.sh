#!/usr/bin/env bash
# Procedural bullet visuals: builds, serves the real pixi bundle, records the
# asserted loadout videos (vanilla control / signature / max-stack monster) and
# captures the per-mod + combo still gallery. PNGs/mp4s land in E2E_OUT and are
# copied to E2E_SHARE when set.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4897}"
export BASE_URL="http://localhost:${PORT}"
export E2E_OUT="${E2E_OUT:-e2e/output}"

echo "[bullet-visuals] building…"
pnpm exec vite build >/dev/null

echo "[bullet-visuals] serving on :${PORT}…"
pnpm exec vite preview --port "$PORT" --strictPort >/tmp/e2e-bullet-visuals-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

rc=0
node e2e/feature-bullet-visuals.mjs || rc=1
node e2e/shots-bullet-visuals.mjs || rc=1

echo "[bullet-visuals] done. artifacts in $E2E_OUT"
exit "$rc"
