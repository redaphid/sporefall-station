#!/usr/bin/env bash
#
# Build the Android debug APK reliably, regardless of the machine's default
# `java`. Capacitor 8 / AGP 8.13 compile the capacitor-android module at Java
# 21, so a JDK < 21 fails with "invalid source release: 21". This script
# locates a JDK 21+ and the Android SDK, then runs the web build -> cap sync ->
# gradle assembleDebug. Fails loud if a prerequisite is missing.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Print the major Java version for a JDK home (handles the legacy 1.x scheme),
# or nothing if it can't be determined.
java_major() {
  local home="$1" v
  [ -x "$home/bin/java" ] || return 1
  v="$("$home/bin/java" -version 2>&1 | awk -F'"' '/version/{print $2; exit}')" || return 1
  [ -n "$v" ] || return 1
  case "$v" in
    1.*) echo "$v" | cut -d. -f2 ;;
    *)   echo "$v" | cut -d. -f1 ;;
  esac
}

ge21() { local m; m="$(java_major "$1" 2>/dev/null || true)"; [ -n "$m" ] && [ "$m" -ge 21 ] 2>/dev/null; }

# --- Resolve a JDK 21+ -------------------------------------------------------
JDK=""
# 1) an already-good JAVA_HOME (CI sets this via setup-java)
if [ -n "${JAVA_HOME:-}" ] && ge21 "$JAVA_HOME"; then
  JDK="$JAVA_HOME"
fi
# 2) the `java` currently on PATH
if [ -z "$JDK" ] && command -v java >/dev/null 2>&1; then
  jbin="$(command -v java)"
  rl="$(readlink -f "$jbin" 2>/dev/null || echo "$jbin")"
  cur="$(cd "$(dirname "$rl")/.." 2>/dev/null && pwd || true)"
  if [ -n "$cur" ] && ge21 "$cur"; then JDK="$cur"; fi
fi
# 3) common install locations (Linux, the bundled SDK JDK, Android Studio, mac)
if [ -z "$JDK" ]; then
  for c in \
    "${ANDROID_HOME:-}/jdk-21" "$HOME/android/jdk-21" \
    /usr/lib/jvm/*21* /usr/lib/jvm/*-21-* \
    "$HOME/Library/Android/sdk/jdk-21" \
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home"; do
    [ -n "$c" ] || continue
    if ge21 "$c"; then JDK="$c"; break; fi
  done
fi
# 4) macOS java_home helper
if [ -z "$JDK" ] && [ -x /usr/libexec/java_home ]; then
  cand="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
  [ -n "$cand" ] && JDK="$cand"
fi
if [ -z "$JDK" ]; then
  echo "ERROR: need a JDK 21+ to build the APK (Capacitor 8 compiles at Java 21)." >&2
  echo "       Install Temurin 21 (or similar), or set JAVA_HOME to a JDK 21+." >&2
  exit 1
fi
export JAVA_HOME="$JDK"
echo "Using JDK $(java_major "$JAVA_HOME"): $JAVA_HOME"

# --- Resolve the Android SDK -------------------------------------------------
if [ -z "${ANDROID_HOME:-}" ]; then
  for s in "$HOME/android" "$HOME/Android/Sdk" "$HOME/Library/Android/sdk" "$HOME/AppData/Local/Android/Sdk"; do
    if [ -d "$s/platform-tools" ] || [ -d "$s/cmdline-tools" ] || [ -d "$s/platforms" ]; then
      ANDROID_HOME="$s"; break
    fi
  done
fi
if [ -z "${ANDROID_HOME:-}" ] || [ ! -d "${ANDROID_HOME:-/nonexistent}" ]; then
  echo "ERROR: Android SDK not found. Set ANDROID_HOME to your SDK install." >&2
  exit 1
fi
export ANDROID_HOME
export ANDROID_SDK_ROOT="$ANDROID_HOME"
echo "Using Android SDK: $ANDROID_HOME"
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > "$ROOT/android/local.properties"

# --- Build -------------------------------------------------------------------
cd "$ROOT"
pnpm run build
pnpm exec cap sync android
( cd android && ./gradlew assembleDebug "$@" )

APK="$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$APK" ]; then
  echo ""
  echo "APK built: $APK ($(du -h "$APK" | cut -f1))"
  echo "Install with: adb install -r \"$APK\"   (or: pnpm run install:apk)"
else
  echo "ERROR: build finished but no APK at $APK" >&2
  exit 1
fi
