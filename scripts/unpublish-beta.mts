#!/usr/bin/env tsx
// Remove a published beta from KV — the undo half of scripts/publish-beta.mts.
//
//   pnpm run beta:unpublish --pr 123              # drop /betas/pr-123/
//   pnpm run beta:unpublish --branch preview/foo  # drop /betas/foo/
//
// WHY THIS EXISTS. Betas are permanent until someone removes them, and the
// `pull_request` trigger in .github/workflows/preview-web.yml publishes a whole
// `dist/` (500+ keys) for EVERY open PR. Without a delete on close, KV grows by
// a full build per PR forever and `/betas/` fills with rows for work that
// merged months ago — the listing stops being a menu of things worth playing,
// which is the only job it has. docs/deploy.md § E "Housekeeping" used to spell
// this out as a two-command manual chore; this is that chore, exactly, so CI
// can run it.
//
// Like publishing, this is an UPLOAD-side operation against KV. It never
// deploys the Worker, never touches production's routes or assets, and can only
// affect keys under this one beta's prefix.
//
// IT IS DELIBERATELY NOT FATAL ON "NOTHING THERE". A PR closed without ever
// having published (a fork PR, a PR opened while the workflow was red) has no
// keys, and a cleanup job that goes red for that would train everyone to ignore
// a red cleanup job.

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { resolveBetaSlug } from '../src/app/betaSlug.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BINDING = 'BETAS'

const die = (message: string): never => {
  console.error(`unpublish-beta: ${message}`)
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

interface Options {
  branch: string
  pr: string
  local: boolean
}

const parseArgs = (argv: string[]): Options => {
  const opts: Options = {
    branch: process.env.BETA_SLUG ?? '',
    pr: (process.env.BETA_PR ?? '').trim(),
    local: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--branch') opts.branch = argv[++i] ?? ''
    else if (arg === '--pr') opts.pr = (argv[++i] ?? '').trim()
    else if (arg === '--local') opts.local = true
    else die(`unknown argument ${arg}`)
  }
  return opts
}

const main = (): void => {
  const opts = parseArgs(process.argv.slice(2))
  const store = opts.local ? '--local' : '--remote'
  const slug = resolveBetaSlug({ pr: opts.pr, branch: opts.branch })
  if (slug === null) die('nothing identifies a beta — pass --pr <number> or --branch <name>')

  // `wrangler kv key list` prints human chatter before the JSON array, the same
  // shape publish-beta.mts parses. Slice from the first `[` rather than trying
  // to make wrangler quiet: the chatter is not part of its contract either way.
  const listed = run(['kv', 'key', 'list', '--binding', BINDING, '--prefix', `b/${slug}/`, store])
  const keys: string[] = (() => {
    try {
      return (JSON.parse(listed.slice(listed.indexOf('['))) as { name: string }[]).map((k) => k.name)
    } catch {
      return []
    }
  })()

  // The `i/<slug>` listing row is deleted in the SAME batch as the bytes, not
  // after them: a half-removed beta whose row survives keeps `/betas/`
  // advertising a URL whose files are gone — a 404 wearing a link.
  const all = [...keys, `i/${slug}`]
  const dir = mkdtempSync(join(tmpdir(), 'sporefall-unbeta-'))
  const file = join(dir, 'delete.json')
  writeFileSync(file, JSON.stringify(all))
  run(['kv', 'bulk', 'delete', file, '--binding', BINDING, store, '--force'])

  if (keys.length === 0) console.error(`· no files were published under b/${slug}/ — nothing to remove`)
  console.error(`✓ removed ${keys.length} file(s) and the index entry for ${slug}`)
  console.log(slug)
}

main()
