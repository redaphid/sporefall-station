#!/usr/bin/env bash
# Share-button touch e2e: prove a person on a PHONE, in a normal game with no
# `?debug`, can get a state link onto their clipboard in two taps — and that the
# button goes red instead of lying when the upload fails. See share-button.mjs.
#
# Needs `wrangler dev` rather than `vite preview`: /state is the Worker, not a
# static asset. NOTE that wrangler dev simulates KV LOCALLY and ignores the
# namespace id, so this proves the round trip through the Worker's code — it is
# NOT evidence that a write to the real WORLDS namespace succeeds.
#
# OWN-SERVER VERIFICATION: unique port + the served HTML must reference a bundle
# that exists in THIS checkout's dist/ (port-squatting has bitten agents here).
#
#   ./e2e/run-share-button.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8791}"
export BASE_URL="http://127.0.0.1:${PORT}"
export E2E_OUT="${E2E_OUT:-e2e/output}"

echo "[share-button] building…"
pnpm exec vite build >/dev/null

echo "[share-button] serving on :${PORT} (wrangler dev — /state needs the Worker)…"
pnpm exec wrangler dev --port "$PORT" --inspector-port $((PORT + 500)) >/tmp/e2e-share-button-wrangler.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "$BASE_URL/"; then break; fi
  sleep 0.5
done

if ! kill -0 "$SERVER" 2>/dev/null; then
  echo "[share-button] FATAL: wrangler exited — port ${PORT} squatted? (see /tmp/e2e-share-button-wrangler.log)" >&2
  exit 1
fi
BUNDLE=$(curl -s "$BASE_URL/" | grep -o 'assets/index-[^"]*\.js' | head -1 || true)
if [ -z "$BUNDLE" ] || [ ! -f "dist/$BUNDLE" ]; then
  echo "[share-button] FATAL: server on :${PORT} is not serving this checkout's dist/ (got '$BUNDLE')" >&2
  exit 1
fi
echo "[share-button] verified own server (dist/$BUNDLE)"

node e2e/share-button.mjs "$BASE_URL"
