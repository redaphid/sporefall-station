#!/usr/bin/env bash
# #50 exact-world-state feature videos: build, serve the real pixi bundle, inject
# committed world fixtures (?world=), replay per-tick input, assert final world
# state, and mux an mp4 per feature. Serves on its OWN port (never 5173/4173).
#
#   ./e2e/run-features.sh            # runs every feature-*.mjs
#   ./e2e/run-features.sh fire       # runs only e2e/feature-fire.mjs
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4891}"
export BASE_URL="http://localhost:${PORT}"
export E2E_OUT="${E2E_OUT:-e2e/output}"

echo "[features] building…"
pnpm exec vite build >/dev/null

echo "[features] serving on :${PORT}…"
pnpm exec vite preview --port "$PORT" --strictPort >/tmp/e2e-features-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

if ! command -v ffmpeg >/dev/null; then
  echo "[features] ERROR: ffmpeg not found — the recipe muxes webm→mp4 and verifies it" >&2
  exit 1
fi

# Run a single feature (e.g. `run-features.sh fire`) or all of them.
if [ "$#" -gt 0 ]; then
  files=("e2e/feature-$1.mjs")
else
  files=(e2e/feature-*.mjs)
fi

rc=0
for f in "${files[@]}"; do
  echo "[features] → $f"
  node "$f" || rc=1
done

echo "[features] done. mp4s in $E2E_OUT"
exit "$rc"
