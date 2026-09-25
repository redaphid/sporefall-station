// Per-branch BETA builds, served from KV at /betas/<slug>/.
//
// WHY KV AND NOT A PREVIEW URL: `wrangler versions upload` gives a version its
// own *.workers.dev origin, and workers.dev on this account is covered by a
// wildcard Cloudflare Access app — every such URL 302s to the Access login page
// instead of the game. Proxying to it from here does not help: the subrequest
// hits the same wall, and minting a service token needs Zero Trust scope this
// project's credentials do not have (and must not be given). So the beta bytes
// come from storage instead, with no Access dependency anywhere in the path.
// docs/deploy.md § "Previews" is the long version of that story.
//
// The shape follows /review/* (reviewImages.ts) on purpose: a KV namespace, an
// upload rather than a deploy, and a handler that NEVER falls through to
// ASSETS. That last part is the whole reason this file exists rather than a
// couple of lines in index.ts.
//
// THE TRAP, stated once: wrangler.jsonc sets
// `not_found_handling: "single-page-application"`, so ANY path that reaches the
// assets binding answers 200 with PRODUCTION's index.html — which then loads
// PRODUCTION's /assets/*.js. A reviewer opening /betas/foo/ would get a page
// that looks perfectly healthy and is the wrong build entirely, and no status
// code anywhere would say so. Two rules keep that from happening:
//
//   1. `/betas` and `/betas/*` are in `run_worker_first`, so the request lands
//      here before the assets binding ever sees it, and
//   2. nothing below ever calls env.ASSETS. A miss is a plain-text 404; the SPA
//      fallback is served from the BETA'S OWN index.html, looked up under the
//      same slug, or it is a 404 too.
//
// The matching half of the trap lives in the bundle: Vite has no `base` set, so
// a normally-built bundle served under /betas/foo/ would request /assets/… at
// the ROOT and quietly execute production's JavaScript inside the beta's HTML.
// vite.config.ts sets `base` from BETA_SLUG for exactly this reason — see
// src/app/betaSlug.ts.

import { BETAS_PREFIX, isBetaSlug } from '../app/betaSlug'
import type { Env } from './env'

/** KV key prefix for a beta's file bytes: `b/<slug>/<path>`. */
export const BETA_FILE_PREFIX = 'b/'
/** KV key prefix for a beta's listing entry: `i/<slug>` → BetaIndexEntry JSON. */
export const BETA_INDEX_PREFIX = 'i/'

/** What scripts/publish-beta.mts writes to `i/<slug>` so /betas/ can list it. */
export interface BetaIndexEntry {
  /** The slug, repeated in the value so a listing needs no key surgery. */
  slug: string
  /** The FULL branch name — the slug is only its last segment, so this is the
   * only place a slug collision between two branches is visible. */
  branch: string
  /** Commit the bundle was built from. */
  sha: string
  /** ISO timestamp of the publish. */
  builtAt: string
  /** How many files were uploaded, so a truncated publish is obvious. */
  files: number
}

/** Extension → content-type for the files a Vite build actually emits. Unknown
 * extensions are served as octet-stream rather than guessed at: a wrong
 * content-type on a beta is a debugging session nobody signed up for. */
const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  wasm: 'application/wasm',
  zip: 'application/zip',
}

export const contentTypeFor = (path: string): string => {
  const dot = path.lastIndexOf('.')
  const slash = path.lastIndexOf('/')
  if (dot <= slash) return 'application/octet-stream'
  return CONTENT_TYPES[path.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream'
}

/** What a /betas/… URL means. Pure data so routing is unit-testable without a
 * Worker runtime or a KV namespace — same split as `resolveReviewKey`. */
export type BetaRoute =
  /** `/betas/` — the human-readable listing of published betas. */
  | { kind: 'index' }
  /** `/betas` or `/betas/<slug>` — one canonical URL per thing. */
  | { kind: 'redirect'; to: string }
  /** A file inside one beta. `spa` marks a path that may fall back to THAT
   * beta's index.html (an extensionless deep link, i.e. a client route). */
  | { kind: 'file'; slug: string; path: string; spa: boolean }
  /** Not a servable beta path at all. Must never reach the assets binding. */
  | { kind: 'reject' }

/** Characters a published file path may contain. Vite emits a subset of this;
 * anything else is either an attack or a bug, and both deserve a 404. */
const SAFE_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/**
 * URL pathname → BetaRoute. Canonical paths only: no percent escapes, no `.`
 * or `..` or empty segments, so one file has exactly one URL.
 *
 * The `spa` flag is the deep-link rule: `/betas/x/lobby/42` has no extension in
 * its last segment, so it is a client-side route and gets the beta's own
 * index.html; `/betas/x/assets/index-abc123.js` has one, so a miss is a hard
 * 404 and can never be papered over with HTML.
 */
export const resolveBetaRoute = (pathname: string): BetaRoute => {
  const withoutSlash = BETAS_PREFIX.slice(0, -1) // '/betas'
  if (pathname === withoutSlash) return { kind: 'redirect', to: BETAS_PREFIX }
  if (pathname === BETAS_PREFIX) return { kind: 'index' }
  if (!pathname.startsWith(BETAS_PREFIX)) return { kind: 'reject' }

  const rest = pathname.slice(BETAS_PREFIX.length)
  const cut = rest.indexOf('/')
  const slug = cut === -1 ? rest : rest.slice(0, cut)
  if (!isBetaSlug(slug)) return { kind: 'reject' }
  // `/betas/<slug>` with no trailing slash — one canonical URL per beta.
  if (cut === -1) return { kind: 'redirect', to: `${BETAS_PREFIX}${slug}/` }

  const path = rest.slice(cut + 1)
  if (path === '') return { kind: 'file', slug, path: 'index.html', spa: true }
  if (path.length > 512) return { kind: 'reject' }
  if (!SAFE_PATH_RE.test(path)) return { kind: 'reject' }
  if (path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return { kind: 'reject' }

  const last = path.slice(path.lastIndexOf('/') + 1)
  return { kind: 'file', slug, path, spa: !last.includes('.') }
}

/** KV key holding one file of one beta. */
export const betaFileKey = (slug: string, path: string): string => `${BETA_FILE_PREFIX}${slug}/${path}`
/** KV key holding one beta's listing entry. */
export const betaIndexKey = (slug: string): string => `${BETA_INDEX_PREFIX}${slug}`

/**
 * Cache policy for one served beta file.
 *
 * `assets/` holds Vite's content-hashed chunks — the filename changes whenever
 * the bytes do, so caching them forever is safe and keeps a beta snappy on a
 * phone. EVERYTHING else is `no-store`, because a beta is republished in place
 * on every push to its branch: a cached index.html or sprite would show the
 * reviewer yesterday's build while the URL swears it is current, which is the
 * exact failure this whole route exists to avoid.
 */
export const cacheControlFor = (path: string): string =>
  path.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-store'

/** Plain-text failure — NEVER HTML. An HTML body here would be indistinguishable
 * from the production SPA fallback this route exists to escape. */
const fail = (message: string, status: number): Response =>
  new Response(`${message}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

/** The `/betas/` listing. Deliberately a hand-written page with no JS and no
 * assets: it has to work even when every beta in it is broken. */
export const renderBetaIndex = (entries: readonly BetaIndexEntry[]): string => {
  const rows =
    entries.length === 0
      ? '<p>No betas published yet. Push to a <code>preview/**</code> branch.</p>'
      : `<ul>${entries
          .map(
            (e) =>
              `<li><a href="${BETAS_PREFIX}${escapeHtml(e.slug)}/">${escapeHtml(e.slug)}</a>` +
              ` <small>${escapeHtml(e.branch)} @ ${escapeHtml(e.sha.slice(0, 8))}` +
              ` &middot; ${escapeHtml(e.builtAt)} &middot; ${e.files} files</small></li>`,
          )
          .join('')}</ul>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sporefall betas</title>
<style>body{font:16px/1.6 system-ui,sans-serif;background:#0b0b12;color:#e8e8f0;margin:0;padding:2rem}
a{color:#8fd3ff}small{color:#9a9ab0;display:block}li{margin:.6rem 0}</style>
</head><body><h1>Sporefall betas</h1>${rows}
<p><a href="/">&larr; production</a></p></body></html>`
}

/**
 * Serve /betas/*. Never touches env.ASSETS — see the file header.
 *
 * Responses carry `x-beta-slug`, which is what makes a beta verifiable from the
 * command line: on this origin a 200 proves nothing (the SPA fallback returns
 * one for every path that does not exist), but production has no such header,
 * so its presence says the bytes really came from this beta's KV prefix.
 */
export const handleBeta = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail('method not allowed', 405)

  const route = resolveBetaRoute(new URL(request.url).pathname)
  if (route.kind === 'reject') return fail('not a beta path', 404)

  if (route.kind === 'redirect') {
    return new Response(null, { status: 308, headers: { location: route.to, 'cache-control': 'no-store' } })
  }

  if (route.kind === 'index') {
    const listed = await env.BETAS.list({ prefix: BETA_INDEX_PREFIX })
    const entries: BetaIndexEntry[] = []
    for (const key of listed.keys) {
      const entry = await env.BETAS.get<BetaIndexEntry>(key.name, 'json')
      if (entry) entries.push(entry)
    }
    entries.sort((a, b) => b.builtAt.localeCompare(a.builtAt))
    return new Response(renderBetaIndex(entries), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    })
  }

  // A file inside one beta. On a miss, an EXTENSIONLESS path is a client-side
  // route and gets this beta's own index.html; anything with an extension is a
  // real 404. Neither case may ever reach production's bytes.
  let path = route.path
  let body = await env.BETAS.get(betaFileKey(route.slug, path), 'arrayBuffer')
  if (body === null && route.spa && path !== 'index.html') {
    path = 'index.html'
    body = await env.BETAS.get(betaFileKey(route.slug, path), 'arrayBuffer')
  }
  if (body === null) return fail(`no beta file at ${route.slug}/${route.path}`, 404)

  return new Response(request.method === 'HEAD' ? null : body, {
    headers: {
      'content-type': contentTypeFor(path),
      'cache-control': cacheControlFor(path),
      'x-content-type-options': 'nosniff',
      'x-beta-slug': route.slug,
    },
  })
}
