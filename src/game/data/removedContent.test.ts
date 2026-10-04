import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OBJECTS } from './objects'
import { PROP_PLACEMENT, ROOM_LAYOUT } from '../levelgen/furnish'

// The cash terminal was removed on purpose (money has no sink), and a branch in
// flight had already re-dressed it as a "Payout Terminal". Whichever lands
// second, a returning terminal under either name, in code or in a comment,
// fails here instead of shipping quietly.

const ROOT = process.cwd()
const SELF = relative(ROOT, import.meta.filename)

/** The word in any case, as a whole word: `atm`, `ATMs`, `prop.atm`. */
const WORD = /\batms?\b|payout[\s_-]?terminals?/i
/** The word as an identifier segment: `isAtm`, `ATMMachine`, `atm_tile`, `atm2`. */
const IDENTIFIER = /[a-z](?:Atm|ATM)s?(?![a-z])|\b(?:atm|ATM|Atm)s?(?=[A-Z_\d])/

/** The one line allowed to name it: the wire table's tombstone keeps its index. */
const ALLOWED = new Set(["src/net/protocol/messages.ts:  'atm', // RETIRED"])

const SCANNED = ['src', 'scripts', 'e2e', 'tools', 'docs', 'public/themes', '.claude/skills']
const TEXT = /\.(ts|mts|mjs|js|py|json|md|sh|html)$/
const SKIP_DIRS = new Set(['node_modules', 'output', 'raws'])

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return SKIP_DIRS.has(name) ? [] : files(path)
    return TEXT.test(name) ? [path] : []
  })

const offending = (): string[] =>
  SCANNED.flatMap((d) => files(join(ROOT, d)))
    .map((p) => relative(ROOT, p))
    .filter((rel) => rel !== SELF && !rel.startsWith('src/ui/releaseNotes/'))
    .flatMap((rel) =>
      readFileSync(join(ROOT, rel), 'utf8')
        .split('\n')
        .map((line, i) => ({ key: `${rel}:${line}`, at: `${rel}:${i + 1}: ${line.trim()}`, line }))
        .filter(({ key, line }) => !ALLOWED.has(key) && (WORD.test(line) || IDENTIFIER.test(line)))
        .map(({ at }) => at),
    )

describe('the cash terminal stays removed', () => {
  it('is not a world object under any name', () => {
    expect(OBJECTS.atm).toBeUndefined()
    const names = Object.values(OBJECTS).map((o) => o.name)
    expect(names.filter((n) => WORD.test(n))).toEqual([])
  })

  it('is never furnished into a room', () => {
    expect(PROP_PLACEMENT.atm).toBeUndefined()
    const placed = Object.values(ROOM_LAYOUT).flatMap((groups) => groups.flatMap((g) => Object.values(g)))
    expect(placed).not.toContain('atm')
  })

  it('no code, comment, doc or manifest names it, in any case or as part of an identifier', () => {
    expect(offending()).toEqual([])
  })

  it('the matchers catch every spelling a merge could bring back, and spare look-alikes', () => {
    const hit = (s: string): boolean => WORD.test(s) || IDENTIFIER.test(s)
    for (const s of ["prop('atm', 1, -2)", '// the ATM pays out', 'ATMs on the shopfloor', 'Atm', 'isAtm', 'ATMMachine', 'atm_tile', 'Payout Terminal', 'payout-terminal'])
      expect(hit(s), s).toBe(true)
    for (const s of ['atmosphere', 'Atmos', 'format', 'stateMachine', 'batman'])
      expect(hit(s), s).toBe(false)
  })
})
