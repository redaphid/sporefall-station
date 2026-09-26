#!/usr/bin/env bash
# Build this checkout and serve dist/ on a port this run owns.
#
#   serve.sh start [port]   build (SKIP_BUILD=1 to reuse dist/), serve, wait until ready
#   serve.sh stop  [port]   kill only the preview this script started on that port
#   serve.sh status         list instances this checkout started
#
# The pidfile is the ownership record: stop never kills by name or by port.
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

STATE=e2e/output/verify/.instances
mkdir -p "$STATE"
cmd="${1:-}"
PORT="${2:-${PORT:-4990}}"
PIDFILE="$STATE/$PORT.pid"
LOG="$STATE/$PORT.log"

start() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "already serving on :$PORT (pid $(cat "$PIDFILE")). Run: $0 stop $PORT" >&2
    exit 1
  fi
  if [ "${SKIP_BUILD:-}" != 1 ]; then
    echo "[serve] vite build…"
    pnpm exec vite build >"$STATE/$PORT.build.log" 2>&1 || { tail -20 "$STATE/$PORT.build.log" >&2; exit 1; }
  fi
  [ -f dist/index.html ] || { echo "no dist/index.html; drop SKIP_BUILD" >&2; exit 1; }

  setsid pnpm exec vite preview --port "$PORT" --strictPort --host 127.0.0.1 >"$LOG" 2>&1 &
  echo $! >"$PIDFILE"
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null "http://127.0.0.1:$PORT/" && break
    kill -0 "$(cat "$PIDFILE")" 2>/dev/null || break
    sleep 0.25
  done
  if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    rm -f "$PIDFILE"
    echo "preview exited; port $PORT squatted? see $LOG" >&2
    exit 1
  fi
  "$(dirname "$0")/doctor.sh" "$PORT"
}

stop() {
  [ -f "$PIDFILE" ] || { echo "no instance recorded on :$PORT"; return 0; }
  # setsid made the pid a process-group leader; kill the group so the node child dies too.
  kill -- "-$(cat "$PIDFILE")" 2>/dev/null || true
  rm -f "$PIDFILE"
  echo "stopped :$PORT (evidence kept under e2e/output/verify/)"
}

case "$cmd" in
  start) start ;;
  stop) stop ;;
  status)
    for f in "$STATE"/*.pid; do
      [ -e "$f" ] || { echo "no instances"; break; }
      p=$(basename "$f" .pid)
      kill -0 "$(cat "$f")" 2>/dev/null && echo ":$p pid $(cat "$f") up" || echo ":$p pid $(cat "$f") DEAD (run stop $p)"
    done ;;
  *) echo "usage: $0 start|stop [port] | status" >&2; exit 2 ;;
esac
