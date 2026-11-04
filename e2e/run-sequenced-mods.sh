#!/usr/bin/env bash
# #78 sequenced-mods proof video + stills, recorded in a REAL HEADED browser.
#
# Headful is the requirement, not an option: the point of the capture is what a
# human sees. Two display paths, tried in order:
#
#   1. A local headed chromium on $DISPLAY (`E2E_HEADFUL=1`) — the normal case.
#   2. `E2E_CDP=<devtools url>` — an already-running headed browser elsewhere.
#      Needed on WSL2 when WSLg is wedged: WSLg's :0 accepts the connection but
#      XWayland never answers the X handshake, and its Weston hangs chromium's
#      wayland ozone init too, so no headed browser can start inside the distro.
#      With `networkingMode=mirrored` a Windows-side
#      Chrome is reachable from here AND can reach this script's vite preview
#      on localhost. This script launches its own through e2e/own-chrome.sh
#      when it finds chrome.exe.
#
# Video stays webm when no libx264 ffmpeg is on PATH (Playwright's bundled
# ffmpeg is webm-only); pass E2E_FFMPEG=/path/to/real/ffmpeg for mp4.
set -euo pipefail
cd "$(dirname "$0")/.."
source e2e/own-chrome.sh

PORT="${PORT:-4899}"
export BASE_URL="http://localhost:${PORT}"
export E2E_OUT="${E2E_OUT:-e2e/output}"

echo "[seq-mods] building…"
pnpm exec vite build >/dev/null

echo "[seq-mods] serving on :${PORT}…"
pnpm exec vite preview --port "$PORT" --strictPort --host 0.0.0.0 >/tmp/e2e-seq-mods-preview.log 2>&1 &
SERVER=$!
cleanup() { kill "$SERVER" 2>/dev/null || true; own_chrome_stop; }
trap cleanup EXIT

for _ in $(seq 1 40); do
  curl -sf -o /dev/null "$BASE_URL/" && break
  sleep 0.25
done

own_chrome_start
[ -n "${E2E_CDP:-}" ] && echo "[seq-mods] headed browser over CDP: $E2E_CDP" || echo "[seq-mods] headed browser on DISPLAY=${DISPLAY:-}"

rc=0
node e2e/feature-sequenced-mods.mjs || rc=1
echo "[seq-mods] done. artifacts in $E2E_OUT"
exit "$rc"
