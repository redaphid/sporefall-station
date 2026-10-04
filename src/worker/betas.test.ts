import { describe, expect, it } from 'vitest'
import {
  betaFileKey,
  betaIndexKey,
  cacheControlFor,
  contentTypeFor,
  handleBeta,
  renderBetaIndex,
  resolveBetaRoute,
  type BetaIndexEntry,
} from './betas'
import type { Env } from './env'
import { route } from './router'

const enc = new TextEncoder()
const bytes = (text: string): Uint8Array => enc.encode(text)

/** A fake KV namespace over a plain object, with the two access patterns
 * handleBeta uses: typed get (arrayBuffer / json) and a prefix list. */
const kvOver = (entries: Record<string, Uint8Array | string>) => ({
  get: async (key: string, type?: string) => {
    const hit = entries[key]
    if (hit === undefined) return null
    if (type === 'json') return JSON.parse(typeof hit === 'string' ? hit : new TextDecoder().decode(hit))
    const buf = typeof hit === 'string' ? bytes(hit) : hit
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  },
  list: async ({ prefix }: { prefix: string }) => ({
    keys: Object.keys(entries)
      .filter((k) => k.startsWith(prefix))
      .map((name) => ({ name })),
  }),
})

/** The BETAS namespace, plus an ASSETS binding that FAILS THE TEST if it is
 * ever reached. That is the assertion this whole file is built around: nothing
 * under /betas/ may be answered by production's assets, and the SPA fallback
 * makes that failure look like a success from the outside. */
const envWith = (entries: Record<string, Uint8Array | string>): Env =>
  ({
    BETAS: kvOver(entries),
    ASSETS: {
      fetch: async () => {
        throw new Error('ASSETS was reached from a /betas/ request — this is the production-leak bug')
      },
    },
  }) as unknown as Env

const get = (path: string, entries: Record<string, Uint8Array | string> = {}, method = 'GET') =>
  handleBeta(new Request(`https://sporefall.hypnodroid.com${path}`, { method }), envWith(entries))

/** A minimal published beta: the shell, its hashed entry chunk, and a listing
 * entry. The chunk name and the reference inside index.html are the pair the
 * "wrong bundle" bug would break. */
const BETA = {
  'b/sequenced-mods/index.html':
    '<!doctype html><script type="module" src="/betas/sequenced-mods/assets/index-BETA1234.js"></script>',
  'b/sequenced-mods/assets/index-BETA1234.js': 'console.log("beta build")',
  'b/sequenced-mods/themes/index.json': '{"themes":[]}',
  'i/sequenced-mods': JSON.stringify({
    slug: 'sequenced-mods',
    branch: 'feat/sequenced-mods',
    sha: 'abcdef1234567890',
    builtAt: '2026-09-22T10:00:00.000Z',
    files: 3,
  } satisfies BetaIndexEntry),
}

describe('resolveBetaRoute', () => {
  it('routes the index, and canonicalises the slash-less forms', () => {
    expect(resolveBetaRoute('/betas/')).toEqual({ kind: 'index' })
    expect(resolveBetaRoute('/betas')).toEqual({ kind: 'redirect', to: '/betas/' })
    expect(resolveBetaRoute('/betas/sequenced-mods')).toEqual({
      kind: 'redirect',
      to: '/betas/sequenced-mods/',
    })
  })

  it('serves the beta shell for the beta root', () => {
    expect(resolveBetaRoute('/betas/sequenced-mods/')).toEqual({
      kind: 'file',
      slug: 'sequenced-mods',
      path: 'index.html',
      spa: true,
    })
  })

  it('marks an extensionless deep path as SPA-eligible and a hashed asset as not', () => {
    expect(resolveBetaRoute('/betas/x/lobby/42')).toEqual({ kind: 'file', slug: 'x', path: 'lobby/42', spa: true })
    expect(resolveBetaRoute('/betas/x/assets/index-abc123.js')).toEqual({
      kind: 'file',
      slug: 'x',
      path: 'assets/index-abc123.js',
      spa: false,
    })
  })

  it.each([
    ['/betas/Bad-Slug/index.html', 'an uppercase slug'],
    ['/betas/-lead/index.html', 'a slug starting with a dash'],
    ['/betas/x/../../secret', 'a parent-directory segment'],
    ['/betas/x/a//b.js', 'an empty path segment'],
    ['/betas/x/%2e%2e/b.js', 'percent escapes (keys are canonical ASCII)'],
    ['/betas/x/ b.js', 'a space'],
    [`/betas/x/${'a'.repeat(600)}.js`, 'an absurdly long path'],
    ['/betasmith/x/', 'a path that only looks like the prefix'],
    ['/review/a.png', 'an unrelated route'],
  ])('rejects %s (%s)', (path) => {
    expect(resolveBetaRoute(path).kind).toBe('reject')
  })
})

describe('contentTypeFor', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['assets/index-abc.js', 'text/javascript; charset=utf-8'],
    ['assets/style-abc.css', 'text/css; charset=utf-8'],
    ['themes/index.json', 'application/json; charset=utf-8'],
    ['manifest.webmanifest', 'application/manifest+json'],
    ['sprites/cop.png', 'image/png'],
    ['icons/icon.svg', 'image/svg+xml'],
    ['noextension', 'application/octet-stream'],
    ['dir.with.dot/file', 'application/octet-stream'],
    ['weird.qqq', 'application/octet-stream'],
  ])('%s -> %s', (path, expected) => {
    expect(contentTypeFor(path)).toBe(expected)
  })
})

describe('cacheControlFor', () => {
  it('caches content-hashed chunks forever and nothing else at all', () => {
    expect(cacheControlFor('assets/index-abc123.js')).toBe('public, max-age=31536000, immutable')
    // Republished in place on every push to the branch — a cached copy would
    // pin the reviewer to a build he already asked to replace.
    expect(cacheControlFor('index.html')).toBe('no-store')
    expect(cacheControlFor('sprites/cop.png')).toBe('no-store')
    expect(cacheControlFor('themes/index.json')).toBe('no-store')
  })
})

describe('key layout', () => {
  it('keeps file bytes and listing entries in disjoint key spaces', () => {
    expect(betaFileKey('x', 'index.html')).toBe('b/x/index.html')
    expect(betaIndexKey('x')).toBe('i/x')
    expect(betaFileKey('x', 'index.html').startsWith('i/')).toBe(false)
  })
})

describe('handleBeta', () => {
  it('serves the beta shell, and it references the BETA asset path — not the root', async () => {
    const res = await get('/betas/sequenced-mods/', BETA)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('x-beta-slug')).toBe('sequenced-mods')
    const html = await res.text()
    // THE test. A bundle built without `base` would say src="/assets/…", which
    // loads PRODUCTION's JavaScript inside the beta's HTML and still returns 200.
    expect(html).toContain('/betas/sequenced-mods/assets/')
    expect(html).not.toMatch(/src="\/assets\//)
  })

  it('serves a hashed chunk as real JavaScript', async () => {
    const res = await get('/betas/sequenced-mods/assets/index-BETA1234.js', BETA)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await res.text()).toContain('beta build')
  })

  it('falls back to THIS beta’s index.html on a deep client-side route', async () => {
    const res = await get('/betas/sequenced-mods/lobby/42', BETA)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-beta-slug')).toBe('sequenced-mods')
    expect(await res.text()).toContain('/betas/sequenced-mods/assets/')
  })

  it('404s a MISSING asset instead of papering over it with HTML', async () => {
    // The class of bug the /review/* comment warns about: a 200 + index.html for
    // a missing .js is a broken page that reports success.
    const res = await get('/betas/sequenced-mods/assets/index-GONE.js', BETA)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await res.text()).not.toContain('<')
  })

  it('404s an unknown beta rather than showing production', async () => {
    const res = await get('/betas/no-such-branch/', BETA)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  })

  it('never serves one beta’s files under another beta’s slug', async () => {
    const two = { ...BETA, 'b/other/index.html': '<!doctype html><!--other-->' }
    expect(await (await get('/betas/other/', two)).text()).toContain('other')
    expect(await (await get('/betas/sequenced-mods/', two)).text()).not.toContain('other')
  })

  it('redirects the un-slashed forms so one bundle has one URL', async () => {
    expect((await get('/betas/sequenced-mods', BETA)).headers.get('location')).toBe('/betas/sequenced-mods/')
    expect((await get('/betas', BETA)).headers.get('location')).toBe('/betas/')
    expect((await get('/betas/sequenced-mods', BETA)).status).toBe(308)
  })

  it('answers HEAD with headers and no body', async () => {
    const res = await get('/betas/sequenced-mods/', BETA, 'HEAD')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await res.text()).toBe('')
  })

  it('refuses writes — a beta is published by upload, never by a request', async () => {
    const res = await get('/betas/sequenced-mods/', BETA, 'POST')
    expect(res.status).toBe(405)
  })

  it('lists published betas at /betas/, newest first', async () => {
    const older: BetaIndexEntry = {
      slug: 'older',
      branch: 'preview/older',
      sha: '0000000011111111',
      builtAt: '2026-01-01T00:00:00.000Z',
      files: 1,
    }
    const res = await get('/betas/', { ...BETA, 'i/older': JSON.stringify(older) })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html.indexOf('sequenced-mods')).toBeLessThan(html.indexOf('older'))
    expect(html).toContain('href="/betas/sequenced-mods/"')
    // The full branch name is shown, which is the only place a slug collision
    // between two branches is visible to a human.
    expect(html).toContain('feat/sequenced-mods')
  })

  it('renders an empty listing without pretending a beta exists', async () => {
    expect(await (await get('/betas/')).text()).toContain('No betas published yet')
  })

  it('labels a PR beta by its PR number, and a branch beta by its branch', () => {
    // The two slug rules live side by side in this listing: `pr-<n>` (unique per
    // pull request, minted by CI) and the branch's last segment (which CAN
    // collide). A reader has to be able to tell which rule a row is under, or
    // "why are there two rows for the same work" has no answer on the page.
    const fromPr: BetaIndexEntry = {
      slug: 'pr-81',
      branch: 'feat/beta-pr-comment',
      sha: 'abcdef1234567890',
      builtAt: '2026-09-25T00:00:00.000Z',
      files: 2,
      pr: 81,
    }
    const fromBranch: BetaIndexEntry = {
      slug: 'older',
      branch: 'preview/older',
      sha: '0000000011111111',
      builtAt: '2026-01-01T00:00:00.000Z',
      files: 1,
    }
    const html = renderBetaIndex([fromPr, fromBranch])
    expect(html).toContain('href="/betas/pr-81/"')
    expect(html).toContain('PR #81')
    expect(html).toContain('feat/beta-pr-comment')
    // A branch beta must NOT grow a PR label it never had.
    expect(html).not.toContain('PR #0')
    expect(html).toContain('preview/older')
  })

  it('escapes listing text so a branch name can never inject markup', () => {
    const nasty: BetaIndexEntry = {
      slug: 'x',
      branch: 'feat/<img src=x onerror=alert(1)>',
      sha: 'deadbeefdeadbeef',
      builtAt: '2026-09-22T00:00:00.000Z',
      files: 1,
    }
    const html = renderBetaIndex([nasty])
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
})

describe('worker router', () => {
  /** The real router, with a BETAS namespace and an ASSETS binding that reports
   * what it was asked for. This is where "did /betas/ leak to the SPA fallback"
   * is actually decided — betas.ts can be perfect and still be bypassed by a
   * missing branch in the router. */
  const entryEnv = (assetCalls: string[]): Env =>
    ({
      BETAS: kvOver(BETA),
      ASSETS: {
        fetch: async (req: Request) => {
          assetCalls.push(new URL(req.url).pathname)
          return new Response('<!doctype html><script src="/assets/index-PROD9999.js">', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })
        },
      },
    }) as unknown as Env

  const through = async (path: string) => {
    const calls: string[] = []
    const res = await route(new Request(`https://sporefall.hypnodroid.com${path}`), entryEnv(calls))
    return { res, calls }
  }

  it.each([
    '/betas',
    '/betas/',
    '/betas/sequenced-mods/',
    '/betas/sequenced-mods/lobby/42',
    '/betas/sequenced-mods/assets/index-GONE.js',
    '/betas/no-such-branch/deep/path',
    '/betas/Bad-Slug/',
  ])('never lets %s reach the production assets binding', async (path) => {
    const { res, calls } = await through(path)
    expect(calls).toEqual([])
    expect(await res.text()).not.toContain('index-PROD9999')
  })

  it('still serves everything else from production assets', async () => {
    const { res, calls } = await through('/')
    expect(calls).toEqual(['/'])
    expect(await res.text()).toContain('index-PROD9999')
  })

  it('leaves the neighbouring routes alone', async () => {
    // `/betasmith` only looks like the prefix; it is an ordinary SPA path.
    const { calls } = await through('/betasmith')
    expect(calls).toEqual(['/betasmith'])
  })
})
