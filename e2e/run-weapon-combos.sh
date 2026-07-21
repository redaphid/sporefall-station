#!/usr/bin/env bash
# demo/weapon-combos — build the real pixi bundle, serve it, inject the
# combat-stage fixture re-armed to each weapon/mod combo, replay the tight
# `comboFire` timeline, and mux one labelled mp4 per combo straight into the
# owner's Videos folder. Serves on its own port (never 5173/4173/4891).
#
#   ./e2e/run-weapon-combos.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4893}"
export BASE_URL="http://localhost:${PORT}"
export E2E_OUT="${E2E_OUT:-$HOME/Videos/backseat/weapon-combos}"

mkdir -p "$E2E_OUT"

echo "[combos] building…"
pnpm exec vite build >/dev/null

echo "[combos] serving on :${PORT}…"
pnpm exec vite preview --port "$PORT" --strictPort >/tmp/e2e-combos-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

if ! command -v ffmpeg >/dev/null; then
  echo "[combos] ERROR: ffmpeg not found — the recipe muxes webm→mp4" >&2
  exit 1
fi

echo "[combos] recording → $E2E_OUT"
node e2e/weapon-combos.mjs
echo "[combos] done. mp4s in $E2E_OUT"
