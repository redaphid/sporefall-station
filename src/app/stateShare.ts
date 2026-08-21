// Browser half of shareable debug-state links.
//
// Layer boundary, matching `persistence.ts`: everything here touches DOM APIs
// (`fetch`, `CompressionStream`, `crypto`, `location`), so it lives in
// `src/app/`. The sim-adjacent logic — the payload shape, the rewind ring and
// the self-check — is in `src/debug/stateLink.ts` and stays DOM-free and pure.
//
// OFF THE PLAYER PATH BY CONSTRUCTION: nothing in this module is imported
// statically by `main.ts`. Capture is reached through a dynamic `import()` that
// only runs under `?debug`, so the ring, the compressor and the upload code are
// in a separate chunk the normal boot never downloads or executes. The LOAD side
// (`fetchState`) is likewise only called when `?state=` is actually present.

import {
  captureState,
  isStateLinkPayload,
  StateRing,
  verifyStateLink,
  type StateLinkMeta,
  type StateLinkPayload,
} from '../debug/stateLink'
import type { World } from '../game/world'
import { APP_VERSION, SITE_ORIGIN } from './version'

/** Hostnames that only ever mean "this machine". */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Is this page being served by a NATIVE SHELL out of its own bundled assets,
 * rather than by the site?
 *
 * The Android APK is the case that matters. `capacitor.config.ts` sets no
 * `androidScheme`, so Capacitor's default applies and the webview serves the
 * bundled `dist/` from `https://localhost` -- a real origin, with a real
 * successful `fetch`, that resolves to files inside the APK. A request built
 * from `location.origin` there never reaches the Worker; it hits the app's own
 * SPA fallback and comes back as 200 + index.html.
 *
 * PORTLESS ON PURPOSE. `vite dev` (localhost:5173) and `wrangler dev`
 * (localhost:8787) are localhost too, and they must keep resolving to
 * THEMSELVES: wrangler genuinely serves `/state`, and vite has the
 * `?stateOrigin=` override below. Only a portless localhost -- plus
 * `capacitor://localhost` and a `file://` document, whose origin is the literal
 * string `"null"` -- is a native shell.
 */
const isNativeShellOrigin = (origin: string): boolean => {
  if (!origin || origin === 'null') return true
  try {
    const url = new URL(origin)
    return LOCAL_HOSTS.has(url.hostname) && url.port === ''
  } catch {
    return true
  }
}

/**
 * Where the Worker serves `/state`.
 *
 * Same origin as the page in a browser. Inside the native shell there is no
 * useful page origin, so fall back to the origin the bundle was BUILT for
 * (`SITE_ORIGIN`, baked in by Vite from capacitor.config.ts's OTA URL).
 *
 * The explicit `?stateOrigin=` override still wins over both, which is what
 * keeps `vite dev` (5173) able to point at `wrangler dev` (8787).
 */
export const stateOrigin = (search: string, origin: string, siteOrigin: string = SITE_ORIGIN): string =>
  new URLSearchParams(search).get('stateOrigin') ?? (siteOrigin && isNativeShellOrigin(origin) ? siteOrigin : origin)

const gzip = async (text: string): Promise<Blob> =>
  new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob()

export interface ShareResult {
  id: string
  url: string
  /** Compressed bytes actually uploaded. */
  bytes: number
  /** Uncompressed JSON length, for a sense of what the world costs. */
  rawBytes: number
  /** Ticks of run-up bundled with the capture (0 when no ring was armed). */
  rewindTicks: number
}

/**
 * Capture the live world, verify it, upload it, and return a shareable URL.
 *
 * The verify step is not ceremony: `verifyStateLink` replays the rewind forward
 * and demands it land on the captured world exactly. Refusing to upload a
 * payload that fails means a bad link is caught HERE, by the person who made it,
 * instead of quietly misleading whoever opens it.
 */
export const shareState = async (
  world: World,
  meta: StateLinkMeta = {},
  ring?: StateRing,
  origin: string = stateOrigin(location.search, location.origin),
): Promise<ShareResult> => {
  const payload = captureState(world, { capturedAt: Date.now(), build: APP_VERSION, ...meta }, ring?.rewind())

  const check = verifyStateLink(payload)
  if (!check.ok) throw new Error(`refusing to share a state that does not reproduce itself: ${check.reason}`)

  const json = JSON.stringify(payload)
  const body = await gzip(json)
  const res = await fetch(`${origin}/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/gzip' },
    body,
  })
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${(await res.text()).trim()}`)

  // CHECKS CONTENT-TYPE, NOT JUST STATUS -- the same guard as `fetchState`
  // below, and for the same reason. A 200 is not proof the Worker answered:
  // an SPA fallback (the deployed site's, or the APK's own bundled assets when
  // `origin` wrongly points at the phone) replies 200 with index.html, sails
  // past `res.ok`, and then detonates inside `res.json()` as an unreadable
  // complaint about `<!doctype`. Naming the origin here is most of the
  // diagnosis: it says WHERE the upload actually went.
  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('application/json'))
    throw new Error(
      `upload to ${origin}/state returned ${type || 'no content-type'} instead of JSON — ` +
        `the POST never reached the Worker (an SPA fallback answered with the app shell).`,
    )

  const { id, url } = (await res.json()) as { id: string; url: string }
  return { id, url, bytes: body.size, rawBytes: json.length, rewindTicks: check.rewindTicks }
}

/**
 * Fetch a shared state by id.
 *
 * Checks CONTENT-TYPE, not just status. The Worker serves this app with
 * `not_found_handling: "single-page-application"`, so a route regression would
 * answer with **200 and the game's index.html** — `res.ok` would be true and
 * `res.json()` would throw something unreadable about `<!doctype`. Reporting
 * "the server returned HTML" instead is the difference between a five-second
 * diagnosis and an hour of confusion.
 */
export const fetchState = async (
  id: string,
  origin: string = stateOrigin(location.search, location.origin),
): Promise<StateLinkPayload> => {
  const res = await fetch(`${origin}/state/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`state ${id} unavailable: ${res.status} ${(await res.text()).trim()}`)

  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('application/json'))
    throw new Error(
      `state ${id} returned ${type || 'no content-type'} instead of JSON — ` +
        `the /state route is probably not reaching the Worker (SPA fallback served the app shell).`,
    )

  const payload: unknown = await res.json()
  if (!isStateLinkPayload(payload)) throw new Error(`state ${id} is not a v1 debug-state payload`)
  return payload
}

export { StateRing, verifyStateLink }
