// Theme-pack parity: the pack the game DEFAULTS to must actually carry the art.
//
// charConsistency.test.ts is the standing silhouette tripwire, but it only ever
// reads `public/themes/swampspace/chars` — the 48px BASE pack. The game defaults
// to `swampspace-hires` (src/render/theme.ts DEFAULT_THEME_ID), and the
// resolution chain resolves on the FIRST pack that MENTIONS a key. So base art
// is shadowed by whatever hires already has.
//
// That gap shipped on 2026-08-23: nine regenerated sprites were written into the
// base pack only. The merge was correct, the deploy was green, the browser was
// fresh — and the player saw none of it, because hires answered every key first.
// Every check passed and the outcome was still wrong.
//
// This asserts the STRUCTURE both packs must share. It does NOT yet assert the
// two packs depict the same character — that needs silhouette comparison across
// the 2x scale, and is the deeper follow-up. See docs/art-run-r2-journey.md.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME_ID } from './theme'

const THEMES = join(process.cwd(), 'public', 'themes')
const BASE_ID = 'swampspace'
const EXPECTED_PX: Record<string, number> = { swampspace: 48, 'swampspace-hires': 96 }

type Manifest = { sprites: Record<string, string>; artScale?: number }
const load = (id: string): Manifest =>
  JSON.parse(readFileSync(join(THEMES, id, 'manifest.json'), 'utf8')) as Manifest

/** PNG dimensions straight from the IHDR — no decode needed. */
const pngSize = (p: string): { w: number; h: number } => {
  const b = readFileSync(p)
  expect(b.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}

const charKeys = (m: Manifest): string[] => Object.keys(m.sprites).filter((k) => k.startsWith('char.'))

describe('theme-pack parity — the default pack must carry the art', () => {
  it('the default theme exists and is NOT the base pack (or this test is pointless)', () => {
    expect(existsSync(join(THEMES, DEFAULT_THEME_ID, 'manifest.json'))).toBe(true)
    expect(DEFAULT_THEME_ID).not.toBe(BASE_ID)
  })

  it('every character key in the base pack is also in the default pack', () => {
    const base = new Set(charKeys(load(BASE_ID)))
    const dflt = new Set(charKeys(load(DEFAULT_THEME_ID)))
    const missing = [...base].filter((k) => !dflt.has(k))
    // A key present in base but absent from the default pack falls through and
    // renders — but a key present in BOTH is shadowed, which is the silent case.
    expect(missing).toEqual([])
  })

  it('every character sprite referenced by either pack exists on disk', () => {
    for (const id of [BASE_ID, DEFAULT_THEME_ID]) {
      const m = load(id)
      const missing = [...new Set(charKeys(m).map((k) => m.sprites[k]))].filter(
        (rel) => !existsSync(join(THEMES, id, rel)),
      )
      expect({ pack: id, missing }).toEqual({ pack: id, missing: [] })
    }
  })

  it('each pack renders its characters at the size its artScale claims', () => {
    for (const id of [BASE_ID, DEFAULT_THEME_ID]) {
      const m = load(id)
      const want = EXPECTED_PX[id]
      expect(want).toBeGreaterThan(0)
      // artScale 2 means the art is authored at double density over the SAME
      // logical size; a pack whose files do not match it renders blurred or
      // pixel-doubled with nothing failing.
      expect(want).toBe(48 * (m.artScale ?? 1))
      for (const rel of new Set(charKeys(m).map((k) => m.sprites[k]))) {
        const { w, h } = pngSize(join(THEMES, id, rel))
        expect({ pack: id, rel, w, h }).toEqual({ pack: id, rel, w: want, h: want })
      }
    }
  })
})
