#!/usr/bin/env bash
# Freeze-shatter balance proof, recorded in a REAL HEADED browser: the same
# scenario driven against the PRE-FIX and POST-FIX builds, back to back.
#
# The before/after pair is the whole point, so this script does the swap itself:
# it drops `origin/main`'s `src/game/systems/combat.ts` (the instant-kill rule)
# over the working copy, builds, records `boss-shatter-before`, then restores the
# fix, rebuilds and records `boss-shatter-after`. Both recordings ASSERT the
# behaviour they claim to show (see e2e/boss-shatter-session.mjs), so a 'before'
# clip cannot silently be of a fixed build.
#
# Headful is the requirement, not an option. Two display paths, tried in order:
#   1. a local headed chromium on $DISPLAY (`E2E_HEADFUL=1`);
#   2. `E2E_CDP=<devtools url>` - an already-running headed browser elsewhere.
#      Needed on WSL2 when WSLg is wedged (its :0 accepts the connection but
#      XWayland never answers the handshake). With networkingMode=mirrored a
#      Windows-side `chrome.exe --remote-debugging-port=9333` is reachable from
#      here AND can reach this script's vite preview. Launched below if found.
#
# Video stays webm when no libx264 ffmpeg is on PATH (Playwright's bundled
# ffmpeg is webm-only); pass E2E_FFMPEG=/path/to/real/ffmpeg for mp4.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4896}"
export BASE_URL="http://localhost:${PORT}"
export E2E_OUT="${E2E_OUT:-e2e/output}"
COMBAT=src/game/systems/combat.ts
SAVED=$(mktemp)
cp "$COMBAT" "$SAVED"

SERVER=""
CHROME_PID=""
cleanup() {
  cp "$SAVED" "$COMBAT"; rm -f "$SAVED"
  [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null || true
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "[boss-shatter] serving on :${PORT}..."
pnpm exec vite build >/dev/null
pnpm exec vite preview --port "$PORT" --strictPort --host 0.0.0.0 >/tmp/e2e-boss-shatter-preview.log 2>&1 &
SERVER=$!
for _ in $(seq 1 40); do curl -sf -o /dev/null "$BASE_URL/" && break; sleep 0.25; done

WIN_CHROME="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
if [ -z "${E2E_CDP:-}" ] && [ "${E2E_HEADFUL:-}" != "1" ] && [ -f "$WIN_CHROME" ]; then
  CDP_PORT="${CDP_PORT:-9333}"
  if ! curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${CDP_PORT}/json/version"; then
    echo "[boss-shatter] launching HEADED Windows Chrome on the desktop (CDP :${CDP_PORT})..."
    "$WIN_CHROME" --remote-debugging-port="$CDP_PORT" \
      --user-data-dir='C:\Temp\sporefall-e2e-profile' \
      --no-first-run --no-default-browser-check \
      --window-size=1320,860 --window-position=40,40 about:blank \
      >/tmp/e2e-boss-shatter-chrome.log 2>&1 &
    CHROME_PID=$!
    for _ in $(seq 1 60); do
      curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${CDP_PORT}/json/version" && break
      sleep 0.5
    done
  fi
  export E2E_CDP="http://127.0.0.1:${CDP_PORT}"
fi
[ -n "${E2E_CDP:-}" ] && echo "[boss-shatter] headed browser over CDP: $E2E_CDP" || echo "[boss-shatter] headed browser on DISPLAY=${DISPLAY:-}"

rc=0

echo "[boss-shatter] === BEFORE: restoring origin/main's instant-kill shatter ==="
git show origin/main:"$COMBAT" > "$COMBAT"
pnpm exec vite build >/dev/null
E2E_MODE=before node e2e/boss-shatter-session.mjs || rc=1

echo "[boss-shatter] === AFTER: the fix ==="
cp "$SAVED" "$COMBAT"
pnpm exec vite build >/dev/null
E2E_MODE=after node e2e/boss-shatter-session.mjs || rc=1

echo "[boss-shatter] done. artifacts in $E2E_OUT"
exit "$rc"
