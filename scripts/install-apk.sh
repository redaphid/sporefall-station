#!/usr/bin/env bash
# Install the debug APK to EVERY connected adb device (wired or wireless), not
# just the single default one. Handy for flashing both phones at once.
#
# Usage: pnpm run install:apk   (optionally: bash scripts/install-apk.sh path/to.apk)
set -euo pipefail

APK="${1:-android/app/build/outputs/apk/debug/app-debug.apk}"
PKG="com.hypnodroid.backseat"

if [ ! -f "$APK" ]; then
  echo "APK not found: $APK" >&2
  echo "Build it first:  pnpm run build:apk" >&2
  exit 1
fi

# Devices currently in the 'device' state (skip 'offline'/'unauthorized' rows).
mapfile -t DEVICES < <(adb devices | awk 'NR>1 && $2=="device" {print $1}')

if [ "${#DEVICES[@]}" -eq 0 ]; then
  echo "No connected adb devices. Connect wired, or 'adb connect <ip:port>' for wireless." >&2
  exit 1
fi

echo "Installing $APK to ${#DEVICES[@]} device(s)..."
fail=0
for dev in "${DEVICES[@]}"; do
  model="$(adb -s "$dev" shell getprop ro.product.model 2>/dev/null | tr -d '\r')"
  printf '  → %s (%s): ' "$dev" "$model"
  if adb -s "$dev" install -r "$APK" >/dev/null 2>&1; then
    echo "OK"
  else
    # Common cause: a differently-signed build already installed (debug key
    # differs between machines/CI). Uninstall once, then install fresh.
    echo "in-place failed — uninstalling old build + reinstalling"
    adb -s "$dev" uninstall "$PKG" >/dev/null 2>&1 || true
    if adb -s "$dev" install "$APK" >/dev/null 2>&1; then
      echo "     OK (fresh install)"
    else
      echo "     FAILED on $dev" >&2
      fail=1
    fi
  fi
done
exit "$fail"
