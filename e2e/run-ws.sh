#!/usr/bin/env bash
# WebSocket multiplayer e2e: builds the app, then drives the REAL Cloudflare
# Worker relay (a Durable Object) under `wrangler dev` — first with raw sockets
# (ws-relay: routing/addressing/membership), then with two real browsers playing
# co-op end to end (ws-multiplayer). Each script boots + tears down its own
# `wrangler dev`, so they run sequentially on the same port.
#
#   ./e2e/run-ws.sh
#
# Env: WS_E2E_PORT (8787), E2E_OUT (e2e/output).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[run-ws] building (app + worker typecheck)…"
pnpm run build >/dev/null

echo "[run-ws] relay proof (raw sockets → real Durable Object)…"
node e2e/ws-relay.mjs

echo "[run-ws] co-op proof (two browsers → real relay)…"
node e2e/ws-multiplayer.mjs

echo "[run-ws] done. screenshots in e2e/output"
