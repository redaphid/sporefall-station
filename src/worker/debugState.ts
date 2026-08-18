// Debug state links — `POST /state` stores a captured world, `GET /state/<id>`
// hands it back, and `?state=<id>` on the game boots into it.
//
// STORAGE CHOICE: KV, not a new service and not a Durable Object. A capture is
// an immutable blob fetched by an opaque key with a TTL — exactly KV's shape.
// A DO would mean one instance per link plus an alarm just to expire it, and the
// existing `ROOM` DO is a live relay that stores nothing; borrowing it for blob
// storage would tangle two unrelated lifetimes. This mirrors `reviewImages.ts`,
// which already keeps out-of-band artefacts in KV rather than in the bundle.
//
// THE TRAP THIS ROUTE MUST AVOID (learned the hard way in reviewImages.ts):
// wrangler.jsonc sets `not_found_handling: "single-page-application"`, so any
// path that is NOT handled here answers **200 with the game's index.html**. A
// mis-wired `/state/*` would therefore look perfectly healthy — status 200, a
// body, no error — while `res.json()` blew up on `<!doctype html>`. So
// `/state/*` is listed in `run_worker_first` and this handler NEVER falls
// through to ASSETS: a miss is a real 404 `text/plain`. Verify links by
// CONTENT-TYPE, never by status code alone.
//
// WIRE FORMAT: the client uploads gzip (a mid-run world is ~65 KiB of JSON that
// gzips to ~6 KiB — worth it on a phone), and the gzip bytes are what KV stores.
// GET decompresses and returns plain JSON so a link is `curl`-able and the
// browser needs no special handling; Cloudflare re-compresses on the wire for
// free. Deliberately NOT `content-encoding: gzip` passthrough, which depends on
// runtime re-encoding behaviour that is easy to get subtly wrong.
//
// This module imports NOTHING from `src/game`: tsconfig.worker.json only
// type-checks `src/worker` against workers-types, and the payload only needs a
// structural check here. `deserializeWorld` on the client does the real
// validation, including the level checksum that catches seed/floor drift.

import type { Env } from './env'

export const STATE_PREFIX = '/state'

/** Must match `STATE_ID_RE` in `src/debug/stateLink.ts` (16 chars of
 * Crockford-flavoured base32). Duplicated rather than imported to keep the
 * Worker's compile unit free of app code — the tests pin the two together. */
export const WORKER_STATE_ID_RE = /^[0-9a-hjkmnp-tv-z]{16}$/

/** Crockford-flavoured base32 — no i/l/o/u, so an id survives being read aloud
 * or retyped out of a chat client. */
const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

/** 16 chars x 5 bits = 80 bits. The id is the ONLY thing protecting a link. */
export const STATE_ID_BYTES = 16

/**
 * The Worker mints ids, never the client: a client-chosen id could collide with
 * or deliberately overwrite someone else's link.
 *
 * Byte-for-byte equivalent to `newStateId` in `src/debug/stateLink.ts`. The two
 * cannot share a module — `tsconfig.worker.json` compiles `src/worker` alone
 * against workers-types, and `tsconfig.json` excludes `src/worker` from the app
 * — so `debugState.test.ts` pins them together instead.
 */
export const newWorkerStateId = (randomBytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < STATE_ID_BYTES; i++) out += ID_ALPHABET[randomBytes[i]! & 31]
  return out
}

/** KV key namespace, so debug states can never collide with another feature's
 * keys if this binding is ever shared. */
export const kvKey = (id: string): string => `state:${id}`

/** Links expire. These are debugging artefacts with a days-long useful life, not
 * archives, and an unbounded public write endpoint that never forgets is how you
 * end up hosting someone else's file storage. */
export const STATE_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 days

/** Max COMPRESSED upload. A mid-run world is ~6 KiB gzipped and a rewind buffer
 * a few tens of KiB, so this is ~10x headroom while still bounding abuse. */
export const MAX_COMPRESSED_BYTES = 512 * 1024

/** Max DECOMPRESSED size, checked while inflating. Without this a few hundred
 * bytes of crafted gzip could expand to gigabytes (a zip bomb) inside the
 * isolate — the size cap above is on the compressed side and cannot see it. */
export const MAX_DECOMPRESSED_BYTES = 8 * 1024 * 1024

/** Plain-text failure. NEVER HTML: an HTML body here is indistinguishable from
 * the SPA fallback this route exists to escape. */
const fail = (message: string, status: number): Response =>
  new Response(`${message}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })

/** Pure path parser, split out so it is unit-testable with no Worker runtime
 * (same shape as `resolveReviewKey`/`decideOta`). */
export const resolveStatePath = (pathname: string): { kind: 'create' } | { kind: 'read'; id: string } | null => {
  if (pathname === STATE_PREFIX || pathname === `${STATE_PREFIX}/`) return { kind: 'create' }
  if (!pathname.startsWith(`${STATE_PREFIX}/`)) return null
  const id = pathname.slice(STATE_PREFIX.length + 1)
  return WORKER_STATE_ID_RE.test(id) ? { kind: 'read', id } : null
}

/** Structural check on a decompressed payload. Cheap and deliberately shallow —
 * enough to reject junk and stale schemas before it costs a KV write. */
export const isStorablePayload = (v: unknown): boolean => {
  if (typeof v !== 'object' || v === null) return false
  const p = v as { v?: unknown; world?: unknown }
  return p.v === 1 && typeof p.world === 'object' && p.world !== null
}

/** Inflate gzip with a hard ceiling on the OUTPUT, so a zip bomb is refused
 * mid-stream instead of after it has already allocated. */
const gunzipCapped = async (body: ArrayBuffer, limit: number): Promise<string | null> => {
  const stream = new Response(body).body!.pipeThrough(new DecompressionStream('gzip'))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const joined = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    joined.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(joined)
}

const CORS = {
  // Debug links get pasted around and opened from preview origins and localhost,
  // so reads are explicitly cross-origin friendly. The data is a game snapshot
  // behind an unguessable id; there is nothing here tied to a user session, and
  // no credentials are accepted, so `*` costs nothing.
  'access-control-allow-origin': '*',
}

export const handleDebugState = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url)
  const route = resolveStatePath(url.pathname)
  if (!route) return fail('not a debug-state path', 404)

  if (route.kind === 'create') {
    if (request.method === 'OPTIONS')
      return new Response(null, {
        headers: { ...CORS, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': '*' },
      })
    if (request.method !== 'POST') return fail('method not allowed — POST a gzipped payload', 405)

    const declared = Number(request.headers.get('content-length') ?? '0')
    if (declared > MAX_COMPRESSED_BYTES) return fail(`payload too large (max ${MAX_COMPRESSED_BYTES} bytes gzipped)`, 413)

    const body = await request.arrayBuffer()
    if (body.byteLength === 0) return fail('empty body', 400)
    // Re-check against the ACTUAL bytes: content-length is client-supplied.
    if (body.byteLength > MAX_COMPRESSED_BYTES) return fail(`payload too large (max ${MAX_COMPRESSED_BYTES} bytes gzipped)`, 413)

    let text: string | null
    try {
      text = await gunzipCapped(body, MAX_DECOMPRESSED_BYTES)
    } catch {
      return fail('body was not valid gzip', 400)
    }
    if (text === null) return fail('payload expands beyond the decompressed limit', 413)

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return fail('body was not valid JSON', 400)
    }
    if (!isStorablePayload(parsed)) return fail('not a v1 debug-state payload', 400)

    // 80 bits from the runtime CSPRNG. The id IS the capability — there is no
    // auth on reads — so it must be unguessable, not merely unique.
    const id = newWorkerStateId(crypto.getRandomValues(new Uint8Array(STATE_ID_BYTES)))

    // Store the COMPRESSED bytes: KV bills and caps on stored size.
    await env.DEBUG_STATES.put(kvKey(id), body, { expirationTtl: STATE_TTL_SECONDS })

    return new Response(JSON.stringify({ id, url: `${url.origin}/?state=${id}`, expiresInSeconds: STATE_TTL_SECONDS }), {
      status: 201,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS },
    })
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') return fail('method not allowed', 405)

  const stored = await env.DEBUG_STATES.get(kvKey(route.id), { type: 'arrayBuffer' })
  // A genuine 404 with content-type text/plain — never the SPA's 200 + HTML.
  if (stored === null) return fail(`no debug state at ${route.id} (expired, or never existed)`, 404)

  let text: string | null
  try {
    text = await gunzipCapped(stored, MAX_DECOMPRESSED_BYTES)
  } catch {
    return fail('stored payload is corrupt', 500)
  }
  if (text === null) return fail('stored payload is corrupt', 500)

  return new Response(request.method === 'HEAD' ? null : text, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Immutable: an id is random and its bytes never change.
      'cache-control': `public, max-age=${STATE_TTL_SECONDS}, immutable`,
      'x-content-type-options': 'nosniff',
      ...CORS,
    },
  })
}
