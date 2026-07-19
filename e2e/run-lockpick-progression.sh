#!/usr/bin/env bash
# Lockpick-progression proof: build, serve on an ephemeral port, record the
# previously-blocked bunker mission being finished (pick, pick, breach, steal),
# then publish the mp4 to ~/Videos/backseat. Own port (never 5173/4173).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4971}"
export BASE_URL="http://localhost:${PORT}"

pnpm exec vite build

pnpm exec vite preview --port "$PORT" --strictPort >/tmp/lockpick-progression-preview.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.25
done

node e2e/lockpick-progression.mjs

mkdir -p "$HOME/Videos/backseat"
cp e2e/output/lockpick-progression.mp4 "$HOME/Videos/backseat/"
cp e2e/output/lockpick-progression-*.png "$HOME/Videos/backseat/" 2>/dev/null || true
echo "published: $HOME/Videos/backseat/lockpick-progression.mp4"
