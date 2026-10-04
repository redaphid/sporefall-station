# Sourced by the run-*.sh recorders that need a headed Windows Chrome from WSL.
# The browser comes from scripts/own-chrome.mjs: a fresh profile on a free port
# in 9300-9999, killed afterwards only if its PID, start time, port and profile
# all match the lockfile. The profile is new every run because one still
# holding the game's PWA service worker makes Playwright's connectOverCDP abort
# on that target. Never point these at :9222 (the owner's Chrome) and never kill
# chrome.exe by name.
#
#   source e2e/own-chrome.sh
#   trap 'own_chrome_stop' EXIT   # or call it from your existing cleanup
#   own_chrome_start              # exports E2E_CDP unless E2E_CDP / E2E_HEADFUL=1 is set

OWN_CHROME_LOCK=""

own_chrome_start() {
  if [ -n "${E2E_CDP:-}" ] || [ "${E2E_HEADFUL:-}" = "1" ] || [ ! -f "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" ]; then
    return 0
  fi
  local lock
  lock=$(node scripts/own-chrome.mjs launch)
  OWN_CHROME_LOCK=$(node -p 'JSON.parse(process.argv[1]).lockfile' "$lock")
  E2E_CDP=$(node -p 'JSON.parse(process.argv[1]).cdpUrl' "$lock")
  export E2E_CDP
  echo "[own-chrome] headed Windows Chrome on $E2E_CDP (lock $OWN_CHROME_LOCK)"
}

own_chrome_stop() {
  if [ -n "$OWN_CHROME_LOCK" ]; then
    node scripts/own-chrome.mjs kill "$OWN_CHROME_LOCK" >/dev/null || true
    OWN_CHROME_LOCK=""
  fi
}
