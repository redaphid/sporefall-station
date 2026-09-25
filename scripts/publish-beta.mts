#!/usr/bin/env tsx
// Publish a per-branch BETA build to https://<origin>/betas/<slug>/.
//
//   BETA_SLUG=feat/sequenced-mods pnpm run build     # build with the right base
//   pnpm run beta:publish                            # upload dist/ to KV
//
// For a PULL REQUEST the slug comes from the PR number instead of the branch,
// because every open PR now publishes automatically and two branches ending in
// the same word must not overwrite each other (src/app/betaSlug.ts):
//
//   BETA_PR=123 BETA_SLUG=feat/x pnpm run build      # base = /betas/pr-123/
//   pnpm run beta:publish --pr 123                   # KV prefix b/pr-123/
//
// Removing one again: `pnpm run beta:unpublish --pr 123` (scripts/unpublish-beta.mts).
//
// This is an UPLOAD, not a deploy — the same model as `pnpm run review:image`,
// and for the same reason: a beta has to be reachable BEFORE its PR merges.
// Nothing here touches the production Worker, its routes or its assets. (The
// /betas/* ROUTE itself does ship with the Worker, so it has to be merged and
// deployed once; after that, publishing a beta never needs another deploy.)
//
// WHY KV: workers.dev on this account sits behind a wildcard Cloudflare Access
// app, so `wrangler versions upload` preview URLs answer with a login page.
// See src/worker/betas.ts and docs/deploy.md § "Previews".
//
// THE CHECK THAT MATTERS is assertBaseIsBeta() below. A bundle built WITHOUT
// `BETA_SLUG` asks for its JavaScript at `/assets/…`, and served under
// /betas/<slug>/ that request is answered by PRODUCTION. The reviewer then sees
// the live game wearing the branch's URL, with no error anywhere. So this script
// refuses to publish a dist/ whose index.html does not reference its own base.

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BETAS_PREFIX, resolveBetaSlug } from '../src/app/betaSlug.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BINDING = 'BETAS'
const DEFAULT_ORIGIN = 'https://sporefall.hypnodroid.com'

/** Files that exist in dist/ but have no business in a beta.
 *  - `_headers` / `_redirects` are Cloudflare ASSETS directives; the beta route
 *    serves its own headers and would just be publishing dead config.
 *  - `ota/` and `download/` are the APK/OTA channel. A beta must NEVER publish
 *    an OTA manifest — installed phones would pull an unreviewed build. */
const SKIP = (path: string): boolean =>
  path === '_headers' || path === '_redirects' || path.startsWith('ota/') || path.startsWith('download/')

const die = (message: string): never => {
  console.error(`publish-beta: ${message}`)
  process.exit(1)
}

const run = (args: string[]): string => {
  const bin = join(REPO_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  if (!existsSync(bin)) die('wrangler is not installed — run `pnpm install` first')
  const r = spawnSync(process.execPath, [bin, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (r.status !== 0) die(`wrangler ${args.slice(0, 3).join(' ')} failed\n${r.stdout ?? ''}${r.stderr ?? ''}`)
  return r.stdout ?? ''
}

const git = (args: string[]): string => {
  const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : ''
}

interface Options {
  branch: string
  /** Pull request number, when publishing FOR a PR. Set by the CI job that runs
   * on `pull_request`; it makes the slug `pr-<number>` instead of the branch's
   * last segment, which is the only slug shape two open PRs cannot collide on.
   * Empty string means "publish under the branch name", the original rule. */
  pr: string
  dist: string
  origin: string
  /** Write to `wrangler dev`'s SIMULATED KV instead of the real namespace, so a
   * beta can be exercised end to end (including the multiplayer relay, whose
   * SQLite Durable Object only runs in local mode) before anything is uploaded
   * to the account. */
  local: boolean
}

const parseArgs = (argv: string[]): Options => {
  const opts: Options = {
    // GITHUB_REF_NAME is what the CI job has; the local git branch is the
    // fallback so the same command works from a laptop. On a `pull_request`
    // run GITHUB_REF_NAME is `<n>/merge`, which is not a branch name anybody
    // wants recorded, so the workflow passes BETA_SLUG=<head branch> too.
    branch: process.env.BETA_SLUG || process.env.GITHUB_REF_NAME || git(['rev-parse', '--abbrev-ref', 'HEAD']),
    pr: (process.env.BETA_PR ?? '').trim(),
    dist: join(REPO_ROOT, 'dist'),
    origin: DEFAULT_ORIGIN,
    local: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--branch') opts.branch = argv[++i] ?? ''
    else if (arg === '--pr') opts.pr = (argv[++i] ?? '').trim()
    else if (arg === '--dist') opts.dist = resolve(argv[++i] ?? '')
    else if (arg === '--origin') opts.origin = (argv[++i] ?? '').replace(/\/$/, '')
    else if (arg === '--local') opts.local = true
    else die(`unknown argument ${arg}`)
  }
  return opts
}

/** Every file under `dir`, as slash-separated paths relative to it. */
const walk = (dir: string, base = dir): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full, base) : [relative(base, full).split(sep).join('/')]
  })

/**
 * Refuse to publish a bundle that would load production's code.
 *
 * Vite rewrites the module/preload/stylesheet references in index.html to the
 * configured `base`, so a correctly-built beta says `/betas/<slug>/assets/…`.
 * A bundle built without BETA_SLUG says `/assets/…` — which resolves to the
 * LIVE site, executes the live game's JavaScript inside the beta's HTML, and
 * returns 200 the whole way. There is no runtime symptom to catch it later, so
 * it gets caught here, before anything is uploaded.
 */
const assertBaseIsBeta = (html: string, slug: string): void => {
  const expected = `${BETAS_PREFIX}${slug}/assets/`
  if (!html.includes(expected)) {
    die(
      `dist/index.html does not reference ${expected} — it was not built with BETA_SLUG set.\n` +
        `Rebuild with: BETA_SLUG=${slug} pnpm run build`,
    )
  }
  const rootRef = /(?:src|href)="\/assets\//.exec(html)
  if (rootRef) die(`dist/index.html still references the ROOT asset path (${rootRef[0]}) — production would answer it`)
}

/** Feed wrangler a bulk file in chunks. Both the API and the CLI have limits on
 * a single bulk request; base64 inflates the payload by a third, so chunk on
 * encoded size rather than file count. */
/** `--remote` (the real namespace) or `--local` (wrangler dev's simulated one).
 * Set once from the parsed options; wrangler defaults differ per subcommand, so
 * every call below states it explicitly rather than relying on them. */
let STORE = '--remote'

const bulk = (verb: 'put' | 'delete', payload: unknown[], chunkBytes = 20_000_000): void => {
  if (payload.length === 0) return
  const dir = mkdtempSync(join(tmpdir(), 'sporefall-beta-'))
  let batch: unknown[] = []
  let size = 0
  let n = 0
  const flush = (): void => {
    if (batch.length === 0) return
    const file = join(dir, `bulk-${n++}.json`)
    writeFileSync(file, JSON.stringify(batch))
    const args = ['kv', 'bulk', verb, file, '--binding', BINDING, STORE]
    if (verb === 'delete') args.push('--force')
    run(args)
    batch = []
    size = 0
  }
  for (const item of payload) {
    const encoded = JSON.stringify(item).length
    if (size + encoded > chunkBytes) flush()
    batch.push(item)
    size += encoded
  }
  flush()
}

const main = async (): Promise<void> => {
  const opts = parseArgs(process.argv.slice(2))
  STORE = opts.local ? '--local' : '--remote'
  const slug = resolveBetaSlug({ pr: opts.pr, branch: opts.branch })
  if (slug === null)
    die(
      opts.pr === ''
        ? `branch ${JSON.stringify(opts.branch)} does not sanitize to a usable beta slug`
        : `--pr ${JSON.stringify(opts.pr)} is not a usable pull request number`,
    )
  if (!existsSync(join(opts.dist, 'index.html'))) die(`${opts.dist}/index.html is missing — run the build first`)

  const indexHtml = readFileSync(join(opts.dist, 'index.html'), 'utf8')
  assertBaseIsBeta(indexHtml, slug)

  const files = walk(opts.dist).filter((p) => !SKIP(p))
  if (files.length === 0) die('nothing to publish')

  const records = files.map((path) => ({
    key: `b/${slug}/${path}`,
    value: readFileSync(join(opts.dist, path)).toString('base64'),
    base64: true,
  }))

  // Drop files the previous publish of THIS slug had and this one does not, so
  // a renamed chunk cannot linger and be served to someone's stale HTML.
  const wanted = new Set(records.map((r) => r.key))
  const listed = run(['kv', 'key', 'list', '--binding', BINDING, '--prefix', `b/${slug}/`, STORE])
  const existing: string[] = (() => {
    try {
      return (JSON.parse(listed.slice(listed.indexOf('['))) as { name: string }[]).map((k) => k.name)
    } catch {
      return []
    }
  })()
  const stale = existing.filter((k) => !wanted.has(k))

  bulk('put', records)
  bulk('delete', stale)

  // `pr` is omitted rather than set to 0 for a branch publish: src/worker/
  // betas.ts treats its PRESENCE as the statement "this slug is PR-unique", and
  // a falsy-but-present number would label a branch beta as PR #0.
  const entry = {
    slug,
    branch: opts.branch,
    sha: process.env.GITHUB_SHA || git(['rev-parse', 'HEAD']),
    builtAt: new Date().toISOString(),
    files: records.length,
    ...(opts.pr === '' ? {} : { pr: Number(opts.pr) }),
  }
  bulk('put', [{ key: `i/${slug}`, value: JSON.stringify(entry) }])

  // Read the shell back OUT of KV and compare bytes. This is the only check
  // available before the route is deployed, and it is the one that proves the
  // upload landed under the slug the URL will ask for.
  const roundTrip = run(['kv', 'key', 'get', `b/${slug}/index.html`, '--binding', BINDING, STORE, '--text'])
  const want = createHash('sha256').update(indexHtml.trim()).digest('hex')
  const got = createHash('sha256').update(roundTrip.trim()).digest('hex')
  if (want !== got) die(`KV read-back of b/${slug}/index.html did not match dist/index.html`)

  const url = `${opts.local ? 'http://localhost:8787' : opts.origin}${BETAS_PREFIX}${slug}/`
  console.error(`✓ ${records.length} files → KV prefix b/${slug}/ (${stale.length} stale key(s) removed)`)
  console.error(`✓ read-back of b/${slug}/index.html matches dist/index.html`)
  console.log(url)
}

await main()
