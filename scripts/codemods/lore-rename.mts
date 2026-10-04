// Renames off-theme modern-crime and police vocabulary (cop, thug, gangster,
// heist, ...) to the colony's own words, across code, data, docs and file names.
// The mapping lives in lore-names.json beside this file.
//
//   tsx scripts/codemods/lore-rename.mts            rewrite files and `git mv` renamed paths
//   tsx scripts/codemods/lore-rename.mts --check    exit 1 if any off-theme term remains
//   tsx scripts/codemods/lore-rename.mts --census   counts by category, no writes
//   tsx scripts/codemods/lore-rename.mts --near     words that contain a term but were left alone
//
// Matching is per identifier segment: `copAfter`, `char.cop.s-idle`, `COP_X` and
// `fellowCop` all hit `cop`, while `copy`, `scope` and `Copley` do not. TS/JS is
// walked through the compiler's AST so every hit is classed as an identifier, an
// id string, a prose string or a comment, and so a rename that would land on a
// different identifier already in the file is refused. The replacement words
// never contain an old term, so a second run finds nothing to do.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

interface Mapping {
  terms: Record<string, { to: string; why: string }>
  phrases: { from: string; to: string; why: string }[]
  keep: { pattern: string; why: string }[]
  skipPaths: { prefix: string; why: string }[]
  scoped: { from: string; to: string; files: string[]; why: string }[]
}

type Category = 'identifiers' | 'archetype ids' | 'id strings' | 'prose strings' | 'comments' | 'docs' | 'data' | 'other code' | 'file names'

interface Span { start: number; end: number; category: Category }
interface Edit { start: number; end: number; text: string; term: string; category: Category }

const mapping = JSON.parse(readFileSync(fileURLToPath(new URL('./lore-names.json', import.meta.url)), 'utf8')) as Mapping
const terms = new Map(Object.entries(mapping.terms).map(([k, v]) => [k.toLowerCase(), v.to]))
/** Terms for one file: the global ones plus any scoped to it. A scoped term is a
 * word that is off-theme only in some files, such as `city` naming the theme pack. */
const termsFor = (path: string): Map<string, string> => {
  const here = mapping.scoped.filter((s) => s.files.includes(path))
  return here.length ? new Map([...terms, ...here.map((s): [string, string] => [s.from.toLowerCase(), s.to])]) : terms
}
const keepRes = mapping.keep.map((k) => new RegExp(k.pattern, 'g'))

const TS_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const categoryOf = (path: string): Category =>
  /\.(md|txt|html)$/.test(path) ? 'docs' : /\.(json|jsonc|ya?ml|csv|tsv)$/.test(path) ? 'data' : 'other code'

const casedLike = (sample: string, word: string): string =>
  sample.length > 1 && sample === sample.toUpperCase()
    ? word.toUpperCase()
    : sample[0] === sample[0].toUpperCase()
      ? word[0].toUpperCase() + word.slice(1)
      : word

const startsWithVowel = (s: string): boolean => /^[aeiou]/i.test(s)

const overlaps = (ranges: [number, number][], s: number, e: number): boolean => ranges.some(([a, b]) => s < b && e > a)

/** Every edit that brings `text` on theme. Spans say where to look and how to class a hit. */
const planEdits = (text: string, spans: Span[], terms: Map<string, string>): Edit[] => {
  const masked: [number, number][] = []
  for (const re of keepRes) for (const m of text.matchAll(re)) masked.push([m.index, m.index + m[0].length])
  const spanAt = (i: number): Span | undefined => spans.find((s) => i >= s.start && i < s.end)

  const edits: Edit[] = []
  for (const p of mapping.phrases) {
    for (let i = text.indexOf(p.from); i !== -1; i = text.indexOf(p.from, i + p.from.length)) {
      const span = spanAt(i)
      if (!span || overlaps(masked, i, i + p.from.length)) continue
      edits.push({ start: i, end: i + p.from.length, text: p.to, term: `"${p.from.trim().split('\n')[0].slice(0, 24)}"`, category: span.category })
      masked.push([i, i + p.from.length])
    }
  }

  for (const span of spans) {
    const slice = text.slice(span.start, span.end)
    for (const w of slice.matchAll(/[A-Za-z]+/g)) {
      const wordStart = span.start + w.index
      for (const seg of w[0].matchAll(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g)) {
        const to = terms.get(seg[0].toLowerCase())
        if (!to) continue
        const s = wordStart + seg.index
        const e = s + seg[0].length
        if (overlaps(masked, s, e)) continue
        const replacement = casedLike(seg[0], to)
        const article = seg.index === 0 ? /(^|[^A-Za-z])(an?|An?) $/.exec(text.slice(Math.max(0, s - 4), s)) : null
        if (article && startsWithVowel(seg[0]) !== startsWithVowel(to)) {
          const a = article[2]
          const fixed = startsWithVowel(to) ? `${a}n` : a.slice(0, 1)
          edits.push({ start: s - a.length - 1, end: e, text: `${fixed} ${replacement}`, term: seg[0].toLowerCase(), category: span.category })
        } else {
          edits.push({ start: s, end: e, text: replacement, term: seg[0].toLowerCase(), category: span.category })
        }
      }
    }
  }
  return edits.sort((a, b) => a.start - b.start)
}

const applyEdits = (text: string, edits: Edit[]): string => {
  let out = ''
  let at = 0
  for (const e of edits) {
    out += text.slice(at, e.start) + e.text
    at = e.end
  }
  return out + text.slice(at)
}

const STRINGISH = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.JsxText,
  ts.SyntaxKind.RegularExpressionLiteral,
])

/** Leaf tokens of the AST, plus the trivia (comments) before each one. JSDoc
 * nodes are skipped so their text is read once, as the trivia it is. */
const tsSpans = (path: string, text: string): { spans: Span[]; identifiers: Set<string> } => {
  const kind = /x$/.test(path) ? ts.ScriptKind.TSX : /\.[mc]?js$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind)
  const spans: Span[] = []
  const identifiers = new Set<string>()
  const visit = (node: ts.Node): void => {
    const children = node.getChildren(sf).filter((c) => !(c.kind >= ts.SyntaxKind.FirstJSDocNode && c.kind <= ts.SyntaxKind.LastJSDocNode))
    if (children.length > 0) {
      children.forEach(visit)
      return
    }
    const full = node.getFullStart()
    const start = node.getStart(sf)
    if (start > full) spans.push({ start: full, end: start, category: 'comments' })
    if (node.kind === ts.SyntaxKind.Identifier || node.kind === ts.SyntaxKind.PrivateIdentifier) {
      identifiers.add(node.getText(sf))
      spans.push({ start, end: node.end, category: 'identifiers' })
    } else if (STRINGISH.has(node.kind)) {
      const body = node.getText(sf)
      const inner = body.slice(1, -1)
      spans.push({ start, end: node.end, category: terms.has(inner) ? 'archetype ids' : /\s/.test(inner) ? 'prose strings' : 'id strings' })
    }
  }
  visit(sf)
  return { spans, identifiers }
}

interface FilePlan { path: string; newPath: string; content?: string; edits: Edit[]; pathEdits: Edit[]; collisions: string[] }

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const listed = (args: string[]): string[] =>
  execFileSync('git', ['ls-files', '-z', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean)
const tracked = new Set(listed([]))
const files = [...new Set([...tracked, ...listed(['-o', '--exclude-standard'])])]
  .filter((p) => !mapping.skipPaths.some((s) => p.startsWith(s.prefix)))
  .filter((p) => existsSync(join(root, p)))
  .sort()

const plan = (path: string): FilePlan => {
  const here = termsFor(path)
  const pathEdits = planEdits(path, [{ start: 0, end: path.length, category: 'file names' }], here)
  const newPath = applyEdits(path, pathEdits)
  const buf = readFileSync(join(root, path))
  if (buf.subarray(0, 8000).includes(0)) return { path, newPath, edits: [], pathEdits, collisions: [] }
  const text = buf.toString('utf8')
  let spans: Span[] = [{ start: 0, end: text.length, category: categoryOf(path) }]
  let identifiers = new Set<string>()
  if (TS_EXT.test(path)) ({ spans, identifiers } = tsSpans(path, text))
  const edits = planEdits(text, spans, here)
  const collisions = [...identifiers]
    .map((id) => [id, applyEdits(id, planEdits(id, [{ start: 0, end: id.length, category: 'identifiers' }], here))])
    .filter(([id, renamed]) => renamed !== id && identifiers.has(renamed))
    .map(([id, renamed]) => `${id} -> ${renamed}`)
  return { path, newPath, content: edits.length ? applyEdits(text, edits) : undefined, edits, pathEdits, collisions }
}

const lineOf = (text: string, at: number): number => text.slice(0, at).split('\n').length

const mode = process.argv[2] ?? '--write'
if (!['--write', '--check', '--census', '--near'].includes(mode)) {
  console.error(`unknown flag ${mode}; use --check, --census or --near`)
  process.exit(2)
}

if (mode === '--near') {
  const counts = new Map<string, number>()
  const stems = [...terms.keys()].filter((t) => t.length > 2)
  for (const path of files) {
    const buf = readFileSync(join(root, path))
    if (buf.subarray(0, 8000).includes(0)) continue
    for (const w of buf.toString('utf8').matchAll(/[A-Za-z]+/g)) {
      const segs = [...w[0].matchAll(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g)].map((s) => s[0].toLowerCase())
      if (segs.some((s) => terms.has(s))) continue
      if (stems.some((t) => w[0].toLowerCase().includes(t))) counts.set(w[0], (counts.get(w[0]) ?? 0) + 1)
    }
  }
  for (const [w, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(6)}  ${w}`)
  process.exit(0)
}

const plans = files.map(plan)
const byCategory = new Map<Category, number>()
const byTerm = new Map<string, number>()
for (const p of plans) {
  for (const e of [...p.edits, ...p.pathEdits]) {
    byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + 1)
    byTerm.set(e.term, (byTerm.get(e.term) ?? 0) + 1)
  }
}
const total = [...byCategory.values()].reduce((a, b) => a + b, 0)
const report = (): void => {
  console.log(`${total} off-theme hits in ${plans.filter((p) => p.edits.length || p.pathEdits.length).length} files`)
  for (const [c, n] of [...byCategory].sort((a, b) => b[1] - a[1])) console.log(`  ${c.padEnd(14)} ${n}`)
  console.log('  by term: ' + [...byTerm].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', '))
}

if (mode === '--census') {
  report()
  process.exit(0)
}

if (mode === '--check') {
  if (total === 0) process.exit(0)
  for (const p of plans) {
    const text = p.content === undefined ? '' : readFileSync(join(root, p.path), 'utf8')
    for (const e of p.edits) console.log(`${p.path}:${lineOf(text, e.start)}  ${text.slice(e.start, e.end)} -> ${e.text}  (${e.category})`)
    if (p.pathEdits.length) console.log(`${p.path}  file name -> ${p.newPath}`)
  }
  report()
  console.log('\noff-theme vocabulary found; run: pnpm exec tsx scripts/codemods/lore-rename.mts')
  process.exit(1)
}

const collided = plans.filter((p) => p.collisions.length)
if (collided.length) {
  for (const p of collided) console.error(`${p.path}: rename would collide with an existing identifier: ${p.collisions.join(', ')}`)
  console.error('nothing written; rename the existing identifier first')
  process.exit(2)
}
for (const p of plans) {
  if (p.newPath === p.path || !existsSync(join(root, p.newPath))) continue
  const same = readFileSync(join(root, p.newPath)).equals(p.content === undefined ? readFileSync(join(root, p.path)) : Buffer.from(p.content))
  if (!same) {
    console.error(`${p.path} would be renamed onto ${p.newPath}, which already exists with other content; nothing written`)
    process.exit(2)
  }
}

for (const p of plans) {
  if (p.content !== undefined) writeFileSync(join(root, p.path), p.content)
  if (p.newPath === p.path) continue
  const to = join(root, p.newPath)
  if (existsSync(to)) {
    if (tracked.has(p.path)) execFileSync('git', ['rm', '-q', '-f', '--', p.path], { cwd: root })
    else execFileSync('rm', ['--', join(root, p.path)])
  } else {
    mkdirSync(dirname(to), { recursive: true })
    if (tracked.has(p.path)) execFileSync('git', ['mv', '--', p.path, p.newPath], { cwd: root })
    else execFileSync('mv', ['--', join(root, p.path), to])
  }
  for (let d = dirname(join(root, p.path)); d.startsWith(root + '/') && existsSync(d) && readdirSync(d).length === 0; d = dirname(d)) rmdirSync(d)
}
report()
console.log(`rewrote ${plans.filter((p) => p.content !== undefined).length} files, renamed ${plans.filter((p) => p.newPath !== p.path).length}`)
