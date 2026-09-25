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
#      Windows-side `chrome.exe --remote-debugging-port=9333` is reachable from
#      here AND can reach this script's vite preview. Launched below if found.
#
# Video stays webm when no libx264 ffmpeg is on PATH (Playwright's bundled
# ffmpeg is webm-only); pass E2E_FFMPEG=/path/to/real/ffmpeg for mp4.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4897}"
export BASE_URL="http://localhost:${PORT}"
export E2E_OUT="${E2E_OUT:-e2e/output}"

SERVER=""
CHROME_PID=""
cleanup() {
  [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null || true
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "[boss-bar] building + serving on :${PORT}..."
pnpm exec vite build >/dev/null
pnpm exec vite preview --port "$PORT" --strictPort --host 0.0.0.0 >/tmp/e2e-boss-bar-preview.log 2>&1 &
SERVER=$!
for _ in $(seq 1 40); do curl -sf -o /dev/null "$BASE_URL/" && break; sleep 0.25; done

WIN_CHROME="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
if [ -z "${E2E_CDP:-}" ] && [ "${E2E_HEADFUL:-}" != "1" ] && [ -f "$WIN_CHROME" ]; then
  CDP_PORT="${CDP_PORT:-9333}"
  if ! curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${CDP_PORT}/json/version"; then
    echo "[boss-bar] launching HEADED Windows Chrome on the desktop (CDP :${CDP_PORT})..."
    # A FRESH profile every run. The app registers a PWA service worker, and a
    # profile still holding one from a previous run makes Playwright's
    # connectOverCDP abort on the service_worker target it did not expect
    # ("Assertion error", targetInfo type service_worker). Nothing in this
    # recording needs profile continuity, so throw it away instead.
    rm -rf /mnt/c/Temp/sporefall-bossbar-profile 2>/dev/null || true
    "$WIN_CHROME" --remote-debugging-port="$CDP_PORT" \
      --user-data-dir='C:\Temp\sporefall-bossbar-profile' \
      --no-first-run --no-default-browser-check \
      --window-size=1320,860 --window-position=40,40 about:blank \
      >/tmp/e2e-boss-bar-chrome.log 2>&1 &
    CHROME_PID=$!
    for _ in $(seq 1 60); do
      curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${CDP_PORT}/json/version" && break
      sleep 0.5
    done
  fi
  export E2E_CDP="http://127.0.0.1:${CDP_PORT}"
fi
[ -n "${E2E_CDP:-}" ] && echo "[boss-bar] headed browser over CDP: $E2E_CDP" || echo "[boss-bar] headed browser on DISPLAY=${DISPLAY:-}"

node e2e/boss-bar-session.mjs
rc=$?
echo "[boss-bar] done. artifacts in $E2E_OUT"
exit "$rc"
