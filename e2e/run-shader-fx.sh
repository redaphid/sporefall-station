#!/usr/bin/env bash
# Backbuffer shader-FX proof: build, serve on an ephemeral port, record the four
# feature videos (grenade shockwave+bloom, heat shimmer, max-stack feedback
# trail, exit-portal idle) plus the fx=off control still, then run the headless
# perf comparison. Serves on its OWN port (never 5173/4173).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4981}"
export BASE_URL="http://localhost:${PORT}"

# Own-server check: refuse to reuse a port someone else is already serving.
# Without this, the readiness curl below happily succeeds against a STALE
# preview (e.g. a leftover from an earlier run) and every video/perf number
# would describe a build that is not the one under test.
if curl -sf -o /dev/null --max-time 2 "$BASE_URL/"; then
  echo "ERROR: something is already serving ${BASE_URL} — refusing to record against a server we do not own." >&2
  echo "       Kill it or re-run with PORT=<free port>." >&2
  exit 1
fi

pnpm exec vite build

pnpm exec vite preview --port "$PORT" --strictPort >/tmp/shader-fx-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  # Only accept readiness from OUR server: if it died (port stolen, build
  # broken) the wait must fail loudly rather than fall through to a stranger.
  if ! kill -0 "$SERVER" 2>/dev/null; then
    echo "ERROR: preview server exited early — see /tmp/shader-fx-preview.log" >&2
    exit 1
  fi
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

node e2e/feature-shader-fx.mjs
node scripts/test/shaderfx-perf.mjs
