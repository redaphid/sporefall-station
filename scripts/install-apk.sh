#!/usr/bin/env bash
# Install the debug APK to EVERY connected adb device — and do the tedious
# reconnect dance first, so a dropped wireless phone gets picked back up.
#
# What it does:
#   1. (--reset) force-restart a wedged adb server.
#   2. Auto-discover wireless-debug phones via mDNS and `adb connect` them.
#   3. Install the APK to every device in the 'device' state (uninstall+reinstall
#      fallback for a signature mismatch).
#
# Usage:
#   pnpm run install:apk                 # discover + flash all
#   bash scripts/install-apk.sh --reset  # also force-restart adb first
#   bash scripts/install-apk.sh path/to.apk
set -uo pipefail

APK="android/app/build/outputs/apk/debug/app-debug.apk"
PKG="com.hypnodroid.backseat"
RESET=0
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=1 ;;
    *.apk)   APK="$arg" ;;
  esac
done

log() { printf '%s\n' "$*"; }

if [ ! -f "$APK" ]; then
  log "APK not found: $APK"
  log "Build it first:  pnpm run build:apk"
  exit 1
fi

# 1. Optionally force-restart a wedged adb server (exact-name kill so we don't
#    match this very script's command line, which contains 'adb' everywhere).
if [ "$RESET" -eq 1 ]; then
  log "→ force-restarting adb server"
  pkill -9 -x adb 2>/dev/null || true
  killall -9 adb 2>/dev/null || true
  sleep 1
  timeout 15 adb start-server >/dev/null 2>&1 || true
  sleep 2
fi

# 2. Discover wireless-debug phones over mDNS and connect any we're not already
#    attached to. `adb mdns services` / `connect` can stall, so cap each.
log "→ discovering wireless-debug devices (mDNS)"
mapfile -t ENDPOINTS < <(timeout 8 adb mdns services 2>/dev/null \
  | awk '/_adb-tls-connect/ {print $NF}' | grep -E '^[0-9.]+:[0-9]+$' | sort -u)
for ep in "${ENDPOINTS[@]:-}"; do
  [ -n "$ep" ] || continue
  res="$(timeout 8 adb connect "$ep" 2>&1 | tail -1)"
  log "   $ep — $res"
done

# 3. Install to every device in the 'device' state.
mapfile -t DEVICES < <(timeout 8 adb devices | awk 'NR>1 && $2=="device" {print $1}')
if [ "${#DEVICES[@]}" -eq 0 ]; then
  log ""
  log "No connected adb devices."
  log "  • USB: plug a phone in and accept the debugging prompt."
  log "  • Wireless: Developer options → Wireless debugging → toggle off/on,"
  log "    then re-run (this script auto-discovers it)."
  log "  • If adb seems stuck:  bash scripts/install-apk.sh --reset"
  exit 1
fi

log ""
log "→ installing $APK to ${#DEVICES[@]} device(s)"
fail=0
for dev in "${DEVICES[@]}"; do
  model="$(timeout 8 adb -s "$dev" shell getprop ro.product.model 2>/dev/null | tr -d '\r')"
  printf '   %s (%s): ' "$dev" "$model"
  if timeout 180 adb -s "$dev" install -r "$APK" >/dev/null 2>&1; then
    log "OK"
  else
    # Usually a differently-signed build already installed (local vs CI debug key).
    log "in-place failed — uninstalling old build + reinstalling"
    timeout 30 adb -s "$dev" uninstall "$PKG" >/dev/null 2>&1 || true
    if timeout 180 adb -s "$dev" install "$APK" >/dev/null 2>&1; then
      log "     OK (fresh install)"
    else
      log "     FAILED on $dev"
      fail=1
    fi
  fi
done
exit "$fail"
