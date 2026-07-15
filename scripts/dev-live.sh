#!/usr/bin/env bash
#
# Live-reload dev loop: build a debug APK whose webview loads from THIS laptop's
# Vite dev server, install it to every connected phone, and (unless told not to)
# start Vite. After this, every phone on the same Wi-Fi hot-reloads on each save
# — no rebuild/reinstall for web/gameplay changes. Native/plugin (BLE) changes
# still need a fresh `dev:live` run.
#
# Usage:
#   scripts/dev-live.sh              # auto-detect LAN IP, port 5173
#   scripts/dev-live.sh 192.168.1.184 5173
#   NO_SERVE=1 scripts/dev-live.sh   # build+install only; assume Vite already running
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${2:-5173}"

# --- Resolve the laptop's LAN IP (the address phones will hit) ---------------
IP="${1:-}"
if [ -z "$IP" ]; then
  # IP used to reach the default gateway → the interface phones share.
  IP="$(ip route get 192.168.1.1 2>/dev/null | grep -oE 'src [0-9.]+' | awk '{print $2}')"
  [ -z "$IP" ] && IP="$(ip -4 addr show 2>/dev/null | grep -oE 'inet 192\.168\.[0-9]+\.[0-9]+' | awk '{print $2}' | head -1)"
fi
if [ -z "$IP" ]; then
  echo "ERROR: couldn't auto-detect a 192.168.x LAN IP. Pass it explicitly: scripts/dev-live.sh <ip> [port]" >&2
  exit 1
fi
export CAP_SERVER_URL="http://$IP:$PORT"
echo "Live-reload server: $CAP_SERVER_URL"

# --- Build the live-reload APK (cap sync picks up CAP_SERVER_URL) -------------
npm run build:apk

APK="$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"

# --- Install to every connected device ---------------------------------------
DEVICES="$(adb devices | awk 'NR>1 && $2=="device"{print $1}')"
if [ -z "$DEVICES" ]; then
  echo "WARNING: no connected adb devices to install to." >&2
else
  for d in $DEVICES; do
    echo "Installing to $d ..."
    adb -s "$d" install -r "$APK" >/dev/null && echo "  ok: $d"
  done
fi

echo ""
echo "Done. Phones will load from $CAP_SERVER_URL with hot-reload."
echo "Keep Vite running while you work; relaunch the app on each phone if it doesn't auto-connect."

# --- Start Vite (unless it's already up / NO_SERVE) --------------------------
if [ "${NO_SERVE:-0}" = "1" ]; then
  echo "NO_SERVE set — not starting Vite (assuming it's already running)."
  exit 0
fi
if ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
  echo "Vite already listening on :$PORT — leaving it as-is."
  exit 0
fi
echo "Starting Vite on :$PORT ..."
exec npm run dev -- --host --port "$PORT"
