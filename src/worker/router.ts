// The Worker's request router — every path decision the origin makes, in one
// pure-ish function over its bindings.
//
//   /ws/:room  → the RoomDO Durable Object (WebSocket multiplayer relay)
//   /ota/check → the self-hosted OTA manifest endpoint (handleOta)
//   /review/*  → review-only before/after images from KV (handleReviewImage)
//   /state/*   → shared debug-state captures from KV (handleWorldStore)
//   /betas/*   → per-branch BETA builds from KV (handleBeta)
//   everything else → the built game in dist/, via the ASSETS binding
//
// SPLIT OUT OF index.ts SO IT CAN BE TESTED. index.ts must
// `export { RoomDO }`, which drags in `cloudflare:workers` — a module that only
// exists inside workerd, so importing the entry from a node vitest run fails
// outright. That left the single most consequential thing in the Worker (which
// paths are allowed to reach the SPA fallback) with no test at all. Here, the
// only Workers-specific things are the BINDINGS, which a test can fake.
//
// wrangler.jsonc routes only these prefixes through the Worker at all
// (`run_worker_first`); every other path is served straight from static assets
// (free, cached, with public/_headers + public/_redirects honored). The ASSETS
// fallback at the bottom is belt-and-suspenders for anything that still gets here.

import { STATE_PREFIX, handleWorldStore } from './worldStore'
import { handleOta } from './ota'
import { REVIEW_PREFIX, handleReviewImage } from './reviewImages'
import { handleBeta } from './betas'
import { BETAS_PREFIX } from '../app/betaSlug'
import type { Env } from './env'

export const route = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url)

  // /ws/:room → the room's Durable Object. idFromName makes the room name the
  // stable key, so every peer naming the same room lands on the same instance.
  // A BETA build namespaces its room names by slug before they get here, so
  // beta players cannot land in a live player's simulation — see betaSlug.ts.
  if (url.pathname.startsWith('/ws/')) {
    const room = decodeURIComponent(url.pathname.slice('/ws/'.length)) || 'default'
    const stub = env.ROOM.get(env.ROOM.idFromName(room))
    return stub.fetch(request)
  }

  if (url.pathname === '/ota/check') return handleOta(request, env)

  // /review/* → a before/after image from KV, for embedding in PR bodies.
  // MUST be handled here and never fall through to ASSETS: the SPA fallback
  // would answer a missing image with 200 + index.html. See reviewImages.ts.
  if (url.pathname.startsWith(REVIEW_PREFIX)) return handleReviewImage(request, env)

  // /state/* → a shared debug-state capture (POST to store, GET to fetch).
  // Same rule as /review/*: it MUST be handled here, because the SPA fallback
  // would answer a missing/expired id with 200 + index.html and the game would
  // try to JSON.parse a page of HTML. See worldStore.ts.
  if (url.pathname === STATE_PREFIX || url.pathname.startsWith(`${STATE_PREFIX}/`))
    return handleWorldStore(request, env)

  // /betas/* → a per-branch beta build from KV. Same rule as the two above, and
  // here it is at its most dangerous: the SPA fallback would answer an unknown
  // beta path with 200 + PRODUCTION's index.html, which then loads PRODUCTION's
  // /assets/*.js — a page that looks healthy while showing the reviewer the
  // wrong build entirely. handleBeta never touches ASSETS and resolves its own
  // SPA fallback from the SAME slug. See betas.ts.
  if (url.pathname === BETAS_PREFIX.slice(0, -1) || url.pathname.startsWith(BETAS_PREFIX))
    return handleBeta(request, env)

  return env.ASSETS.fetch(request)
}
