// Cloudflare Worker entry — the single origin that serves EVERYTHING: the built
// game, the multiplayer relay, the OTA manifest, review images, shared debug
// states and the per-branch beta builds.
//
// This module is deliberately TINY. All it does is name the Durable Object
// class and hand `fetch` to the router, because the `export { RoomDO }` below
// imports `cloudflare:workers` — a module that exists only inside workerd, so
// anything in this file is unreachable from a node test run. The routing itself
// lives in router.ts, where it can be (and is) tested; see the header there for
// the route table and for why each KV-backed route must never fall through to
// the ASSETS binding.

import { route } from './router'
import type { Env } from './env'

// The Durable Object class must be exported from the Worker's entry module so the
// `durable_objects` binding in wrangler.jsonc can find it.
export { RoomDO } from './roomDO'

export default {
  async fetch(request, env): Promise<Response> {
    return route(request, env)
  },
} satisfies ExportedHandler<Env>
