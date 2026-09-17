#!/usr/bin/env bash
# §4.2 Echo proof: build, serve on an ephemeral port, drive the `echo-adapt`
# scenario + script in a real browser, assert the adaptive resist map live (it
# learns, it forgets, and `resist.frozen` never moves off 0), and record the
# video + stills. Own port (never 5173/4173) with a liveness check that the
# server answering is OUR preview, not a stale squatter.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4945}"
export BASE_URL="http://localhost:${PORT}"

pnpm exec vite build

pnpm exec vite preview --port "$PORT" --strictPort >/tmp/echo-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

# Port hygiene: if our preview died (port squatted by another process), whatever
# answered that curl is NOT our build — fail loudly instead of testing a ghost.
if ! kill -0 "$SERVER" 2>/dev/null; then
  echo "FATAL: vite preview exited (port ${PORT} squatted?) — see /tmp/echo-preview.log" >&2
  exit 1
fi

node e2e/echo.mjs
