// Cloudflare Worker entry — the single origin that serves EVERYTHING:
//
//   /ws/:room  → the RoomDO Durable Object (WebSocket multiplayer relay)
//   /ota/check → the self-hosted OTA manifest endpoint (handleOta)
//   /review/*  → review-only before/after images from KV (handleReviewImage)
//   everything else → the built game in dist/, via the ASSETS binding
//
// wrangler.jsonc routes only /ws/*, /ota/* and /review/* through this Worker
// (`run_worker_first`); all other paths are served straight from static assets
// (free, cached, with public/_headers + public/_redirects honored). The ASSETS
// fallback below is belt-and-suspenders for anything that still reaches here.

import { STATE_PREFIX, handleDebugState } from './debugState'
import { handleOta } from './ota'
import { REVIEW_PREFIX, handleReviewImage } from './reviewImages'
import type { Env } from './env'

// The Durable Object class must be exported from the Worker's entry module so the
// `durable_objects` binding in wrangler.jsonc can find it.
export { RoomDO } from './roomDO'

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)

    // /ws/:room → the room's Durable Object. idFromName makes the room name the
    // stable key, so every peer naming the same room lands on the same instance.
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
    // try to JSON.parse a page of HTML. See debugState.ts.
    if (url.pathname === STATE_PREFIX || url.pathname.startsWith(`${STATE_PREFIX}/`))
      return handleDebugState(request, env)

    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
