import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OBJECTS } from './objects'
import { PROP_PLACEMENT, ROOM_LAYOUT } from '../levelgen/furnish'

// The ATM was removed on purpose (money has no sink), and a branch in flight
// had already re-dressed it as a "Payout Terminal". Whichever lands second, a
// returning ATM under either name fails here instead of shipping quietly.

const ROOT = process.cwd()
const RETIRED_WIRE_ENTRY = 'src/net/protocol/messages.ts'

const files = (dir: string, ext: RegExp): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path, ext)
    return ext.test(name) ? [path] : []
  })

const mentions = (paths: string[], pattern: RegExp): string[] =>
  paths.filter((p) => pattern.test(readFileSync(p, 'utf8'))).map((p) => relative(ROOT, p))

describe('the ATM stays removed', () => {
  it('is not a world object under any name', () => {
    expect(OBJECTS.atm).toBeUndefined()
    const names = Object.values(OBJECTS).map((o) => o.name)
    expect(names.filter((n) => /\bATM\b|payout terminal/i.test(n))).toEqual([])
  })

  it('is never furnished into a room', () => {
    expect(PROP_PLACEMENT.atm).toBeUndefined()
    const placed = Object.values(ROOM_LAYOUT).flatMap((groups) => groups.flatMap((g) => Object.values(g)))
    expect(placed).not.toContain('atm')
  })

  it('no source spawns, names or draws it', () => {
    const self = relative(ROOT, import.meta.filename)
    const src = files(join(ROOT, 'src'), /\.ts$/).filter((p) => {
      const rel = relative(ROOT, p)
      return rel !== self && rel !== RETIRED_WIRE_ENTRY && !rel.startsWith('src/ui/releaseNotes/')
    })
    expect(mentions(src, /['"]atm['"]|payout terminal|payout-terminal/i)).toEqual([])
  })

  it('no theme manifest names it or ships its art', () => {
    const manifests = files(join(ROOT, 'public', 'themes'), /^manifest\.json$/)
    expect(manifests.length).toBeGreaterThan(0)
    expect(mentions(manifests, /"(prop\.)?atm"|payout terminal|payout-terminal/i)).toEqual([])
  })
})
