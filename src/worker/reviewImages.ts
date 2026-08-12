// Review images — publicly-served before/after artefacts for PR bodies.
//
// WHY THIS EXISTS: this repo is PRIVATE. GitHub does NOT proxy in-repo image URLs
// on a private repo, so `![](…/blob/<sha>/shot.png?raw=true)` in a PR body renders
// as a broken image (the raw URL redirects cross-origin and is blocked). GitHub DOES
// proxy an image at a *publicly reachable* URL through camo.githubusercontent.com,
// and a camo-wrapped image renders. This route is that public address, so a
// contact sheet in a PR body is actually visible to a human reviewer.
//
// These are REVIEW artefacts, not game assets. They live in a KV namespace, never
// in `public/` — so they add zero bytes to the Vite bundle, the OTA zip, and the
// APK. Publishing one is `pnpm run review:image <file>`; it needs no deploy, which
// is the point: a PR's images must be live BEFORE the PR merges.
//
// THE TRAP this handler exists to avoid: wrangler.jsonc sets
// `not_found_handling: "single-page-application"`, so every unknown path answers
// **200 with the game's index.html**. A mis-wired image path would therefore look
// perfectly healthy (200!) while rendering as a broken image — status codes are
// worthless here. So `/review/*` is listed in `run_worker_first` and this handler
// NEVER falls through to ASSETS: a miss is a real 404 `text/plain`, and a hit is
// always `image/*` with `nosniff`. Verify with content-type + magic bytes, not 200.

import type { Env } from './env'

/** Extension → content-type. Deliberately images only. This path is public and
 * same-origin with the game, so no `.svg` and no `.html`: both can carry script. */
const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
}

export const REVIEW_PREFIX = '/review/'

/** How long a review image may be cached. Keys are content-addressed by
 * scripts/review-image.mjs (…-<sha8>.png), so a given URL's bytes never change —
 * caching hard is safe and stops camo re-fetching on every PR view. */
const CACHE_SECONDS = 604800 // 7 days

/** Pure path → KV key + content-type, split out so it is unit-testable without a
 * Worker runtime (same shape as `decideOta`). Canonical keys only: no percent
 * escapes, no `..`, no empty segments, so one image has exactly one URL — and
 * therefore exactly one camo cache entry. Returns null for anything unservable. */
export const resolveReviewKey = (pathname: string): { key: string; contentType: string } | null => {
  if (!pathname.startsWith(REVIEW_PREFIX)) return null
  const key = pathname.slice(REVIEW_PREFIX.length)
  if (key.length === 0 || key.length > 512) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(key)) return null
  if (key.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  const contentType = CONTENT_TYPES[key.slice(key.lastIndexOf('.') + 1).toLowerCase()]
  return contentType ? { key, contentType } : null
}

/** Plain-text failure. Never HTML: an HTML body here would be indistinguishable
 * from the SPA fallback this route exists to escape. */
const fail = (message: string, status: number): Response =>
  new Response(`${message}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })

export const handleReviewImage = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail('method not allowed', 405)

  const resolved = resolveReviewKey(new URL(request.url).pathname)
  if (!resolved) return fail('not a review image path', 404)

  const body = await env.REVIEW_IMAGES.get(resolved.key, { type: 'arrayBuffer', cacheTtl: CACHE_SECONDS })
  if (body === null) return fail(`no review image at ${resolved.key}`, 404)

  return new Response(request.method === 'HEAD' ? null : body, {
    headers: {
      'content-type': resolved.contentType,
      'cache-control': `public, max-age=${CACHE_SECONDS}, immutable`,
      'x-content-type-options': 'nosniff',
    },
  })
}
