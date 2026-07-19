#!/usr/bin/env bash
# feat/sprite-animation showcase. Builds, serves the real pixi bundle on its
# OWN port (4949 — claimed for this suite; do not reuse), and records the
# asserted animation-states mp4 + precision per-state stills (the sim is
# paused at each target tick). Artifacts land in E2E_OUT and are copied to
# VIDEO_DIR (default ~/Videos/backseat) when it exists or can be created.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4949}"
export BASE_URL="http://localhost:${PORT}"
export E2E_OUT="${E2E_OUT:-e2e/output}"
VIDEO_DIR="${VIDEO_DIR:-$HOME/Videos/backseat}"

echo "[anim-states] building…"
pnpm exec vite build >/dev/null

echo "[anim-states] serving on :${PORT}…"
pnpm exec vite preview --port "$PORT" --strictPort >/tmp/e2e-anim-states-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done
# Verify OUR server owns the port (port squatting has bitten multiple agents):
# the process serving must be the preview we just spawned, still alive.
if ! kill -0 "$SERVER" 2>/dev/null; then
  echo "[anim-states] FATAL: preview server died — is port ${PORT} already taken?" >&2
  cat /tmp/e2e-anim-states-preview.log >&2
  exit 1
fi

rc=0
node e2e/feature-anim-states.mjs || rc=1

if mkdir -p "$VIDEO_DIR" 2>/dev/null; then
  cp "$E2E_OUT"/anim-states.mp4 "$VIDEO_DIR"/ 2>/dev/null || true
  cp "$E2E_OUT"/anim-states-*.png "$VIDEO_DIR"/ 2>/dev/null || true
  echo "[anim-states] copied artifacts to $VIDEO_DIR"
fi

echo "[anim-states] done. artifacts in $E2E_OUT"
exit "$rc"
