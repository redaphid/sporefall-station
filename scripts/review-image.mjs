#!/usr/bin/env node
// Publish a before/after image for a PR body.
//
//   pnpm run review:image shots/winners.png
//   pnpm run review:image a.png b.png --prefix prop-sweep
//
// Prints a markdown line to paste into the PR body. This is an UPLOAD, not a
// deploy: the image is live within seconds and needs no merge, which is what
// makes it usable for reviewing a PR that has not landed yet.
//
// WHY: the repo is PRIVATE, so GitHub refuses to proxy in-repo image URLs and
// every `?raw=true` image in a PR body renders broken. A publicly reachable URL
// IS proxied (camo.githubusercontent.com) and renders. See src/worker/reviewImages.ts.
//
// Images go to a KV namespace, never into the repo or `public/` — they are review
// artefacts and must not bloat the game bundle, the OTA zip, or the APK.
//
// Keys are content-addressed (…-<sha8>.png): re-uploading identical bytes is a
// no-op, and a URL's bytes never change, so caching (and camo) can't go stale.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BINDING = 'REVIEW_IMAGES'
const DEFAULT_ORIGIN = 'https://sporefall.hypnodroid.com'

/** Extensions this route serves — must match CONTENT_TYPES in reviewImages.ts. */
const ALLOWED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'])

/** Leading bytes every real file of that type starts with. Verified after upload
 * so this tool can never hand back a URL that serves something else. */
const MAGIC = {
  '.png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  '.jpg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  '.webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  '.avif': (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
}
MAGIC['.jpeg'] = MAGIC['.jpg']

const die = (message) => {
  console.error(`review-image: ${message}`)
  process.exit(1)
}

const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

const gitBranch = () => {
  const run = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' })
  return run.status === 0 ? slug(run.stdout.trim()) : ''
}

const parseArgs = (argv) => {
  const files = []
  const opts = { prefix: '', origin: DEFAULT_ORIGIN, verify: true }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--prefix') opts.prefix = slug(argv[++i] ?? '')
    else if (arg === '--origin') opts.origin = (argv[++i] ?? '').replace(/\/$/, '')
    else if (arg === '--no-verify') opts.verify = false
    else if (arg.startsWith('-')) die(`unknown option ${arg}`)
    else files.push(arg)
  }
  if (files.length === 0) die('usage: review-image <file.png> [more.png…] [--prefix name] [--origin url] [--no-verify]')
  return { files, opts }
}

/** node_modules/wrangler/bin/wrangler.js, invoked directly so no shell quoting
 * rules (and no Windows .cmd shim) can mangle a path with spaces in it. */
const wranglerBin = () => {
  const bin = join(REPO_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  if (!existsSync(bin)) die('wrangler is not installed — run `pnpm install` first')
  return bin
}

const upload = (key, file) => {
  const run = spawnSync(
    process.execPath,
    [wranglerBin(), 'kv', 'key', 'put', key, '--path', file, '--binding', BINDING, '--remote'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  if (run.status !== 0) die(`wrangler kv key put failed for ${key}\n${run.stdout ?? ''}${run.stderr ?? ''}`)
}

/** Fetch the public URL and prove it is an image — content-type AND magic bytes.
 * A 200 proves nothing here: unknown paths fall through to the SPA fallback and
 * return the game's index.html with status 200. */
const verify = async (url, ext) => {
  const res = await fetch(url, { cache: 'no-store', redirect: 'follow' })
  const type = res.headers.get('content-type') ?? ''
  const bytes = Buffer.from(await res.arrayBuffer())
  if (!res.ok) return `HTTP ${res.status}`
  if (type.startsWith('text/html')) {
    return `served text/html — the /review/* Worker route is not deployed at ${new URL(url).origin} yet, so the SPA fallback answered instead (status was still 200)`
  }
  if (!type.startsWith('image/')) return `content-type was ${type || '(none)'}, not image/*`
  if (!MAGIC[ext](bytes)) return `content-type said ${type} but the bytes are not a valid ${ext.slice(1)}`
  return null
}

const { files, opts } = parseArgs(process.argv.slice(2))
const prefix = opts.prefix || gitBranch() || 'review'
const lines = []

for (const file of files) {
  const ext = extname(file).toLowerCase()
  if (!ALLOWED.has(ext)) die(`${file}: only ${[...ALLOWED].join(', ')} are served (svg/html are refused on purpose)`)
  if (!existsSync(file)) die(`${file}: no such file`)

  const bytes = readFileSync(file)
  if (!MAGIC[ext](bytes)) die(`${file}: does not look like a real ${ext.slice(1)} — refusing to publish a broken image`)

  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
  const key = `${prefix}/${slug(basename(file, ext))}-${hash}${ext}`
  const url = `${opts.origin}/review/${key}`

  upload(key, file)
  if (opts.verify) {
    const problem = await verify(url, ext)
    if (problem) die(`uploaded ${key}, but ${url} did not serve it back: ${problem}`)
  }
  console.error(`✓ ${file} → ${url}${opts.verify ? ' (verified: image bytes)' : ' (UNVERIFIED)'}`)
  lines.push(`![${basename(file, ext)}](${url})`)
}

console.log(lines.join('\n'))
