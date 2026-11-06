// Which tracked binary assets does nothing use? Prints the deletion list with a
// reason per group, and the kept list with the evidence that kept each file.
//
//   pnpm exec tsx scripts/find-unused-assets.mts            # report
//   pnpm exec tsx scripts/find-unused-assets.mts --list     # deletable paths only
//   pnpm exec tsx scripts/find-unused-assets.mts --json     # full verdicts
//   pnpm exec tsx scripts/find-unused-assets.mts --days 14  # recent-branch window
//
// An asset is KEPT when any of these holds, checked in this order:
//
//   1. protected  — Android launcher/splash resources, the Capacitor icon/splash
//                   sources in assets/, and the PWA icons. Never pruned here.
//   2. manifest   — a public/themes/<id>/manifest.json `sprites` entry resolves
//                   to it. This is how the game loads every theme file: keys are
//                   enumerated by the engine (render/theme.ts SPRITE_KEYS) and
//                   resolved to paths ONLY through the manifest
//                   (resolveSpritePaths), so a theme file the manifest does not
//                   name can never be fetched by the runtime.
//   3. path       — some tracked text file (source, html, json, markdown, python,
//                   shell...) contains a path to it of two or more segments,
//                   e.g. `sprites/props/tv.png` or `prop-sweep/before.png`.
//   4. dir        — a text file names its folder on its own (`docs/assets/foo/`,
//                   `docs/assets/foo/{a,b}.png`, `.../walk-<dir>.png`): a doc
//                   that points at a folder of proofs vouches for all of them.
//   5. basename   — some tracked text file contains its bare file name. Covers a
//                   markdown/html file linking a sibling (`![](shot.png)`) and
//                   pipeline scripts that join a dir with a name. Deliberately
//                   loose: a false keep is cheap, a false delete is not.
//   6. stem       — a text file contains the name with its trailing frame index,
//                   direction or extension stripped (`foo-` / `foo_` for
//                   `foo-3.png`), i.e. the path is likely built at runtime.
//   7. branch     — the same checks (3–6), run against every text file changed
//                   on a remote branch with a commit in the last N days, or the
//                   asset itself is added/changed on that branch. Deleting
//                   something in-flight work uses is a semantic merge conflict.
//
// Anything left is deletable. The search corpus is every TRACKED text file on
// HEAD plus the changed files of each recent branch — untracked/gitignored
// files are neither searched nor ever deleted.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, posix } from 'node:path'

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const args = process.argv.slice(2)
const daysArg = args.indexOf('--days')
const DAYS = daysArg >= 0 ? Number(args[daysArg + 1]) : 14
if (!Number.isFinite(DAYS) || DAYS < 0) throw new Error(`--days needs a non-negative number`)

const ASSET_RE = /\.(png|webp|jpe?g|gif|avif|mp4|webm|mov|ogg|mp3|wav|glb|gltf|blend|psd|kra|ttf|otf|woff2?)$/i
const PROTECTED: readonly { prefix: string; why: string }[] = [
  { prefix: 'android/', why: 'Android launcher/splash resources (built into the APK by Gradle)' },
  { prefix: 'assets/', why: 'Capacitor icon/splash sources (@capacitor/assets input)' },
  { prefix: 'public/icons/', why: 'PWA icons (manifest.webmanifest / index.html)' },
  {
    prefix: 'scripts/assets/',
    why: 'art-pipeline masters/lineage: raws/ and anchors/ are the committed home of curated picks (docs/sprite-generation.md §2b)',
  },
]

const git = (...a: string[]): string => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
const gitBuf = (...a: string[]): Buffer => execFileSync('git', a, { cwd: ROOT, maxBuffer: 1 << 28 })

const tracked = git('ls-files', '-z').split('\0').filter(Boolean)
const assets = tracked.filter((f) => ASSET_RE.test(f) && existsSync(join(ROOT, f)))

const isText = (buf: Buffer): boolean => !buf.subarray(0, 8000).includes(0)
const TEXT_MAX = 8 << 20

// ---------------------------------------------------------------------------
// Corpus: path → text. HEAD's tracked text files, then each recent branch's
// changed text files under a `<ref>:<path>` label.

interface Doc {
  label: string
  text: string
  branch?: string
}
const corpus: Doc[] = []
for (const f of tracked) {
  if (ASSET_RE.test(f) || f === 'pnpm-lock.yaml') continue
  const p = join(ROOT, f)
  if (!existsSync(p) || statSync(p).size > TEXT_MAX) continue
  const buf = readFileSync(p)
  if (isText(buf)) corpus.push({ label: f, text: buf.toString('utf8') })
}

const since = Date.now() / 1000 - DAYS * 86400
const recentRefs = git('for-each-ref', '--sort=-committerdate', '--format=%(committerdate:unix) %(refname:short)', 'refs/remotes')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [t, ref] = l.split(' ')
    return { t: Number(t), ref }
  })
  .filter((r) => r.t >= since && !r.ref.endsWith('/HEAD') && r.ref !== 'origin/main' && r.ref !== 'origin')

const branchTouched = new Map<string, string[]>() // asset path → refs that add/change it
for (const { ref } of recentRefs) {
  let changed: string[]
  try {
    changed = git('diff', '--name-only', '--diff-filter=AMR', '-z', `HEAD...${ref}`).split('\0').filter(Boolean)
  } catch {
    continue // unrelated history — nothing to compare
  }
  for (const f of changed) {
    if (ASSET_RE.test(f)) {
      branchTouched.set(f, [...(branchTouched.get(f) ?? []), ref])
      continue
    }
    let buf: Buffer
    try {
      buf = gitBuf('show', `${ref}:${f}`)
    } catch {
      continue
    }
    if (buf.length <= TEXT_MAX && isText(buf)) corpus.push({ label: `${ref}:${f}`, text: buf.toString('utf8'), branch: ref })
  }
}

// ---------------------------------------------------------------------------
// Manifest reachability (mirrors render/theme.ts resolveSpritePaths: a leading
// "/" is app-root = public/, otherwise relative to the theme's folder).

const manifestRefs = new Map<string, string>() // asset path → theme id
const themesDir = join(ROOT, 'public/themes')
for (const id of readdirSync(themesDir)) {
  const m = join(themesDir, id, 'manifest.json')
  if (!existsSync(m)) continue
  const sprites = (JSON.parse(readFileSync(m, 'utf8')) as { sprites?: Record<string, unknown> }).sprites ?? {}
  for (const v of Object.values(sprites)) {
    for (const p of [v].flat()) {
      if (typeof p !== 'string') continue
      const file = p.startsWith('/') ? posix.join('public', p) : posix.join('public/themes', id, p)
      if (!manifestRefs.has(file)) manifestRefs.set(file, id)
    }
  }
}

// ---------------------------------------------------------------------------
// Text search. Needles are searched as whole tokens: the character before and
// after must not be a filename character, so `tv.png` doesn't match `atv.png`.

const NAME_CH = /[A-Za-z0-9_.\-]/
const findIn = (needle: string, docs: readonly Doc[]): Doc | undefined => {
  for (const d of docs) {
    let i = d.text.indexOf(needle)
    while (i >= 0) {
      const before = d.text[i - 1]
      const after = d.text[i + needle.length]
      const okBefore = before === undefined || !NAME_CH.test(before) || needle.startsWith('/') || before === '/'
      const okAfter = after === undefined || !NAME_CH.test(after) || needle.endsWith('-') || needle.endsWith('_')
      if (okBefore && okAfter) return d
      i = d.text.indexOf(needle, i + 1)
    }
  }
  return undefined
}

/** `a/b/c/d.png` → [`a/b/c/d.png`, `b/c/d.png`, `c/d.png`]. */
const pathNeedles = (f: string): string[] => {
  const segs = f.split('/')
  const out: string[] = []
  for (let i = 0; i <= segs.length - 2; i++) out.push(segs.slice(i).join('/'))
  return out
}

/** Stem with a trailing frame index / direction / state stripped, keeping the
 * separator so `mutant-s-walk-` cannot match `mutant-swamp`. Empty when the name
 * has no such tail (the basename check already covered it). Stems shorter than
 * 6 chars are too generic to count as evidence of anything. */
const stemNeedles = (f: string): string[] => {
  const name = basename(f).replace(ASSET_RE, '')
  const out = new Set<string>()
  let s = name
  for (;;) {
    const m = /^(.*?[-_])([0-9]+|[a-z]{1,2}|idle|step|walk|run|attack|hurt|die|death|front|back|side|left|right|up|down|before|after)$/.exec(s)
    if (!m) break
    s = m[1].slice(0, -1)
    if (m[1].length >= 6) out.add(m[1])
  }
  return [...out]
}

interface Verdict {
  file: string
  bytes: number
  keep: boolean
  rule: 'protected' | 'manifest' | 'path' | 'dir' | 'basename' | 'stem' | 'branch' | 'unused'
  why: string
}

const headDocs = corpus.filter((d) => !d.branch)
const branchDocs = corpus.filter((d) => d.branch)

/** Folders that hold other folders (`docs/assets`, `public/sprites`). Naming
 * one is about layout — an output dir, a cache glob — not a vouch for the loose
 * files in it, so the dir rule only applies to LEAF folders. */
const containerDirs = new Set<string>()
for (const f of tracked) {
  const segs = f.split('/').slice(0, -1)
  for (let i = 1; i < segs.length; i++) containerDirs.add(segs.slice(0, i).join('/'))
}

/** The asset's leaf folder, as a 2+-segment suffix, named on its own: followed
 * by end of token, or by `/` and then a non-filename character (`/`, `{`, `<`,
 * `*`, backtick...). `docs/assets/foo/bar.png` does NOT vouch for the folder. */
const findDir = (f: string, docs: readonly Doc[]): { needle: string; doc: Doc } | undefined => {
  if (containerDirs.has(dirname(f))) return undefined
  const segs = dirname(f).split('/')
  for (let i = 0; i <= segs.length - 2; i++) {
    const needle = segs.slice(i).join('/')
    for (const d of docs) {
      let at = d.text.indexOf(needle)
      while (at >= 0) {
        const before = d.text[at - 1]
        let j = at + needle.length
        if (d.text[j] === '/') j++
        const after = d.text[j]
        const okBefore = before === undefined || before === '/' || !NAME_CH.test(before)
        if (okBefore && (after === undefined || !NAME_CH.test(after))) return { needle, doc: d }
        at = d.text.indexOf(needle, at + 1)
      }
    }
  }
  return undefined
}

const textEvidence = (f: string, docs: readonly Doc[]): { rule: 'path' | 'dir' | 'basename' | 'stem'; why: string } | undefined => {
  for (const n of pathNeedles(f)) {
    const d = findIn(n, docs)
    if (d) return { rule: 'path', why: `\`${n}\` in ${d.label}` }
  }
  const dir = findDir(f, docs)
  if (dir) return { rule: 'dir', why: `\`${dir.needle}/\` in ${dir.doc.label}` }
  const b = basename(f)
  const d = findIn(b, docs)
  if (d) return { rule: 'basename', why: `\`${b}\` in ${d.label}` }
  for (const s of stemNeedles(f)) {
    const ds = findIn(s, docs)
    if (ds) return { rule: 'stem', why: `\`${s}*\` in ${ds.label}` }
  }
  return undefined
}

const verdicts: Verdict[] = assets.map((file) => {
  const bytes = statSync(join(ROOT, file)).size
  const prot = PROTECTED.find((p) => file.startsWith(p.prefix))
  if (prot) return { file, bytes, keep: true, rule: 'protected', why: prot.why }
  const theme = manifestRefs.get(file)
  if (theme) return { file, bytes, keep: true, rule: 'manifest', why: `public/themes/${theme}/manifest.json` }
  const head = textEvidence(file, headDocs.filter((d) => d.label !== file))
  if (head) return { file, bytes, keep: true, ...head }
  const touched = branchTouched.get(file)
  if (touched) return { file, bytes, keep: true, rule: 'branch', why: `changed on ${touched.join(', ')}` }
  const br = textEvidence(file, branchDocs)
  if (br) return { file, bytes, keep: true, rule: 'branch', why: `${br.rule}: ${br.why}` }
  return { file, bytes, keep: false, rule: 'unused', why: 'no manifest entry, path, basename or stem reference on HEAD or any recent branch' }
})

// ---------------------------------------------------------------------------
// Report.

const del = verdicts.filter((v) => !v.keep)
if (args.includes('--list')) {
  for (const v of del) console.log(v.file)
  process.exit(0)
}
if (args.includes('--json')) {
  console.log(JSON.stringify({ days: DAYS, branches: recentRefs.map((r) => r.ref), verdicts }, null, 2))
  process.exit(0)
}

const mb = (n: number): string => (n / 1048576).toFixed(2)
const groupKey = (f: string): string => {
  const d = dirname(f)
  return d.startsWith('public/themes/') ? d.split('/').slice(0, 4).join('/') : d.split('/').slice(0, 3).join('/')
}
const table = (rows: readonly Verdict[], by: (v: Verdict) => string): void => {
  const g = new Map<string, { n: number; bytes: number }>()
  for (const v of rows) {
    const k = by(v)
    const e = g.get(k) ?? { n: 0, bytes: 0 }
    e.n++
    e.bytes += v.bytes
    g.set(k, e)
  }
  for (const [k, e] of [...g].sort((a, b) => b[1].bytes - a[1].bytes))
    console.log(`  ${String(e.n).padStart(5)}  ${mb(e.bytes).padStart(7)} MB  ${k}`)
}

console.log(`tracked assets: ${assets.length} (${mb(verdicts.reduce((s, v) => s + v.bytes, 0))} MB)`)
console.log(`recent remote branches (≤${DAYS}d, ${recentRefs.length}): ${recentRefs.map((r) => r.ref).join(' ') || '(none)'}`)
console.log(`\nKEPT by rule:`)
table(verdicts.filter((v) => v.keep), (v) => v.rule)
console.log(`\nKEPT by rule × directory:`)
table(verdicts.filter((v) => v.keep), (v) => `${v.rule.padEnd(9)} ${groupKey(v.file)}`)
console.log(`\nKEPT on weak evidence (dir / basename / stem / branch) — inspect these:`)
for (const v of verdicts.filter((v) => ['dir', 'basename', 'stem', 'branch'].includes(v.rule)))
  console.log(`  ${v.rule.padEnd(9)} ${v.file}  <- ${v.why}`)
console.log(`\nDELETABLE: ${del.length} files, ${mb(del.reduce((s, v) => s + v.bytes, 0))} MB`)
table(del, (v) => groupKey(v.file))
for (const v of del) console.log(`  ${v.file}`)
