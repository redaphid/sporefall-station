// Side-by-side diff of census outputs (the markdown `scripts/census.mts`
// prints, or a doc holding its census:begin block), one column per file in
// the order given. Prints every build x arena cell and reach-probe row that
// differs between any two of them.
//
//   npx tsx scripts/census-diff.mts main=before.md +92=after92.md ...
import { readFileSync } from 'node:fs'

const inputs = process.argv.slice(2).map((arg) => {
  const eq = arg.indexOf('=')
  return eq < 0 ? { label: arg, path: arg } : { label: arg.slice(0, eq), path: arg.slice(eq + 1) }
})
if (inputs.length < 2) throw new Error('usage: npx tsx scripts/census-diff.mts label=census.md label=census.md [...]')

interface Census {
  cells: Map<string, Map<string, string>>
  arenas: string[]
  reach: Map<string, string>
}

const tableAfter = (lines: string[], heading: string): string[][] => {
  const start = lines.findIndex((l) => l.startsWith(heading))
  if (start < 0) return []
  const rows: string[][] = []
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith('#')) break
    if (!l.startsWith('|') || l.startsWith('|---')) continue
    rows.push(l.split('|').slice(1, -1).map((c) => c.trim().replace(/\*\*/g, '')))
  }
  return rows
}

const parse = (path: string): Census => {
  const lines = readFileSync(path, 'utf8').split('\n')
  const [header, ...rows] = tableAfter(lines, '### Build x arena')
  if (!header) throw new Error(`${path}: no "### Build x arena" table`)
  const arenas = header.slice(1)
  const cells = new Map<string, Map<string, string>>()
  for (const [build, ...vals] of rows) cells.set(build, new Map(arenas.map((a, i) => [a, vals[i]])))
  const reach = new Map<string, string>()
  for (const [d, fires, first, shots, , taken] of tableAfter(lines, '### Reach probe').slice(1)) {
    reach.set(`${d} | ${fires}`, `${first === 'never' ? first : `${first} s`}, ${shots} shots, ${taken} dmg`)
  }
  return { cells, arenas, reach }
}

const all = inputs.map((i) => ({ ...i, census: parse(i.path) }))
const first = all[0].census
const arenas = first.arenas.filter((a) => all.every((c) => c.census.arenas.includes(a)))
const builds = [...first.cells.keys()].filter((b) => all.every((c) => c.census.cells.has(b)))
const labels = all.map((c) => c.label).join(' | ')
const out: string[] = []

out.push(`| build | arena | ${labels} |`, `|---|---|${all.map(() => '---').join('|')}|`)
let changed = 0
for (const b of builds) {
  for (const a of arenas) {
    const vals = all.map((c) => c.census.cells.get(b)!.get(a)!)
    if (new Set(vals).size === 1) continue
    out.push(`| ${b} | ${a} | ${vals.join(' | ')} |`)
    changed++
  }
}
out.push('', `${changed} of ${builds.length * arenas.length} cells differ.`, '')

const reachRows = [...first.reach.keys()].filter((k) => new Set(all.map((c) => c.census.reach.get(k))).size > 1)
if (reachRows.length) {
  out.push(`| distance (tiles) | player fires | ${labels} |`, `|---|---|${all.map(() => '---').join('|')}|`)
  for (const k of reachRows) out.push(`| ${k} | ${all.map((c) => c.census.reach.get(k) ?? '').join(' | ')} |`)
}
console.log(out.join('\n'))
