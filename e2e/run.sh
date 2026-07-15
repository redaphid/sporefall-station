#!/usr/bin/env bash
# Reusable e2e proof harness: build, serve, drive a keyboard play session +
# asset showcase in Chromium, record video + screenshots, convert to mp4/gif.
#
#   ./e2e/run.sh
#
# Env: PORT (4173), E2E_SEED (424242), SHARE_DIR (optional copy target).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PORT="${PORT:-4173}"
OUT="$ROOT/e2e/output"
BASE_URL="http://localhost:${PORT}"

echo "[run] building…"
pnpm exec vite build >/dev/null

echo "[run] serving on :${PORT}…"
pnpm exec vite preview --port "$PORT" --strictPort >/tmp/e2e-preview.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

for i in $(seq 1 30); do
  if curl -sf -o /dev/null "$BASE_URL/"; then echo "[run] server up"; break; fi
  echo "[run] poll $i…"; sleep 1
done

echo "[run] driving game play session…"
BASE_URL="$BASE_URL" node e2e/play-session.mjs

echo "[run] recording asset showcase…"
BASE_URL="$BASE_URL" node e2e/record-showcase.mjs

echo "[run] recording deterministic gameplay videos…"
for demo in gameplay-demo doors shooting mission; do
  echo "[run] → $demo"
  BASE_URL="$BASE_URL" E2E_OUT="$OUT" node "e2e/$demo.mjs"
done

echo "[run] converting to mp4 + gif…"
if command -v ffmpeg >/dev/null; then
  for name in web-game-proof assets-showcase; do
    ffmpeg -y -i "$OUT/$name.webm" -vf "scale=1280:-2" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "$OUT/$name.mp4" >/dev/null 2>&1
    ffmpeg -y -i "$OUT/$name.webm" -vf "fps=12,scale=640:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" "$OUT/$name.gif" >/dev/null 2>&1
  done
  echo "[run] mp4 + gif written to $OUT"
else
  echo "[run] ffmpeg missing — keeping .webm only"
fi

if [ -n "${SHARE_DIR:-}" ]; then
  cp "$OUT"/web-game-proof.{mp4,gif,webm} "$OUT"/assets-showcase.{mp4,gif} "$OUT"/web-e2e-*.png "$SHARE_DIR"/ 2>/dev/null || true
  echo "[run] copied artifacts to $SHARE_DIR"
fi

echo "[run] done. artifacts in $OUT"
