#!/usr/bin/env bash
# Boss health bar proof, recorded in a REAL HEADED browser.
#
# Headful is the requirement, not an option — this is a claim about what reaches
# the glass, and a headless compositor is not the thing being claimed. Two
# display paths, tried in order (same as run-boss-shatter.sh):
#   1. a local headed chromium on $DISPLAY (`E2E_HEADFUL=1`);
#   2. `E2E_CDP=<devtools url>` — an already-running headed browser elsewhere.
#      Needed on WSL2 when WSLg is wedged (its :0 accepts the connection but
#      XWayland never answers the handshake). With networkingMode=mirrored a
#      Windows-side Chrome is reachable from here AND can reach this script's
#      vite preview. Launched below via e2e/own-chrome.sh if chrome.exe is found.
#
# Video stays webm when no libx264 ffmpeg is on PATH (Playwright's bundled
# ffmpeg is webm-only); pass E2E_FFMPEG=/path/to/real/ffmpeg for mp4.
set -euo pipefail
cd "$(dirname "$0")/.."
source e2e/own-chrome.sh

PORT="${PORT:-4897}"
export BASE_URL="http://localhost:${PORT}"
export E2E_OUT="${E2E_OUT:-e2e/output}"

SERVER=""
cleanup() {
  [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null || true
  own_chrome_stop
}
trap cleanup EXIT

echo "[boss-bar] building + serving on :${PORT}..."
pnpm exec vite build >/dev/null
pnpm exec vite preview --port "$PORT" --strictPort --host 0.0.0.0 >/tmp/e2e-boss-bar-preview.log 2>&1 &
SERVER=$!
for _ in $(seq 1 40); do curl -sf -o /dev/null "$BASE_URL/" && break; sleep 0.25; done

own_chrome_start
[ -n "${E2E_CDP:-}" ] && echo "[boss-bar] headed browser over CDP: $E2E_CDP" || echo "[boss-bar] headed browser on DISPLAY=${DISPLAY:-}"

node e2e/boss-bar-session.mjs
rc=$?
echo "[boss-bar] done. artifacts in $E2E_OUT"
exit "$rc"
