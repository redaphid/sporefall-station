#!/usr/bin/env bash
# §4.1 The Vigil proof: build, serve on an ephemeral port, drive the `vigil`
# scenario + script in a real browser, assert the noise budget from LIVE world
# state (vulnerable asleep · loud wakes it · backing off settles it · each wake
# longer than the last), and record the annotated video. Own port (never
# 5173/4173) with a liveness check that the server answering is OUR preview.
#
# NOTE ON ffmpeg: deliberately NO `command -v ffmpeg` gate here. e2e/lib.mjs now
# resolves the mux binary itself ($FFMPEG_PATH → PATH → playwright's bundled
# copy) and keeps the raw webm when none of them can encode h264 — so a dev box
# without system ffmpeg still gets a real recording instead of an early exit.
# CI installs ffmpeg with apt and takes the mp4 path unchanged.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4943}"
export BASE_URL="http://localhost:${PORT}"

pnpm exec vite build

pnpm exec vite preview --port "$PORT" --strictPort >/tmp/vigil-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

# Port hygiene: if our preview died (port squatted by another process), whatever
# answered that curl is NOT our build — fail loudly instead of testing a ghost.
if ! kill -0 "$SERVER" 2>/dev/null; then
  echo "FATAL: vite preview exited (port ${PORT} squatted?) — see /tmp/vigil-preview.log" >&2
  exit 1
fi

node e2e/vigil.mjs
