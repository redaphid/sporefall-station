#!/usr/bin/env bash
# Read-only: is the instance on :PORT ours, alive, and serving this checkout's current build?
# Exit 0 = worth driving. Every failed line says why.
set -uo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

PORT="${1:-${PORT:-4990}}"
PIDFILE=e2e/output/verify/.instances/$PORT.pid
BASE="http://127.0.0.1:$PORT"
bad=0
ok() { echo "ok   $*"; }
no() { echo "FAIL $*"; bad=1; }

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  ok "preview pid $(cat "$PIDFILE") alive (started by serve.sh)"
else
  no "no live instance recorded for :$PORT; run serve.sh start $PORT"
fi

html=$(curl -sf "$BASE/" || true)
[ -n "$html" ] && ok "$BASE answers" || no "$BASE does not answer"

bundle=$(grep -o 'assets/index-[^"]*\.js' <<<"$html" | head -1)
if [ -n "$bundle" ] && [ -f "dist/$bundle" ]; then
  ok "serves this checkout's dist/$bundle"
else
  no "served bundle '$bundle' is not in this checkout's dist/ (someone else's server?)"
fi

newest_src=$(find src index.html -type f -newer dist/index.html 2>/dev/null | head -1)
[ -z "$newest_src" ] && ok "dist/ is newer than every src/ file" || no "dist/ is stale ($newest_src changed after the build); restart without SKIP_BUILD"

echo "build: $(git rev-list --count HEAD)$( [ -n "$(git status --porcelain)" ] && echo +) at $(git rev-parse --short HEAD) on $(git branch --show-current)"
exit $bad
