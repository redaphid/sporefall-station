// The theme manifest is a COMMITTED artifact, and a stale one silently breaks
// the game: a macro pool listing fewer files than macro² drops the engine out
// of the macro path to per-tile hashing (this exact bug shipped the bog
// checkerboard — the manifest listed 8 of 48 grass tiles), and a pool naming a
// deleted file 404s at load. This gate keeps every shipped manifest honest
// against the files actually on disk, in both directions, for every theme —
// the TS twin of `scripts/assets/sync_manifest.py --check` (which regenerates
// pools after tile work), running wherever vitest runs so drift can't merge
// or deploy.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const THEMES_DIR = join(__dirname, '..', '..', 'public', 'themes')

interface Manifest {
  sprites?: Record<string, unknown>
  macroTiles?: Record<string, number>
}

const themes = readdirSync(THEMES_DIR).filter((d) => {
  const p = join(THEMES_DIR, d)
  return statSync(p).isDirectory() && existsSync(join(p, 'manifest.json'))
})

const load = (theme: string): Manifest =>
  JSON.parse(readFileSync(join(THEMES_DIR, theme, 'manifest.json'), 'utf8')) as Manifest

/** Every string (or string[] entry) in `sprites` that looks like a file path. */
const referencedFiles = (m: Manifest): string[] => {
  const out: string[] = []
  for (const v of Object.values(m.sprites ?? {})) {
    if (typeof v === 'string') out.push(v)
    else if (Array.isArray(v)) for (const e of v) if (typeof e === 'string') out.push(e)
  }
  return out.filter((f) => f.endsWith('.png'))
}

// Mirrors sync_manifest.py: pooled tile art discovered from the tiles/ dir.
const SURFACES = ['street', 'sidewalk', 'floor', 'wall', 'grass', 'exit'] as const
const POOLS: readonly { key: (n: string) => string; pattern: (n: string) => RegExp }[] = [
  { key: (n) => `tile.${n}`, pattern: (n) => new RegExp(`^${n}-(\\d+)\\.png$`) },
  { key: (n) => `tile.${n}.accent`, pattern: (n) => new RegExp(`^${n}-accent-(\\d+)\\.png$`) },
  { key: (n) => `tile.${n}.overlay`, pattern: (n) => new RegExp(`^${n}-overlay-(\\d+)\\.png$`) },
]

describe('theme manifests stay in sync with the assets on disk', () => {
  it('found the shipped themes', () => {
    expect(themes).toContain('swampspace-hires')
    expect(themes).toContain('swampspace')
  })

  // The `test` theme deliberately references does-not-exist.png as the
  // graceful-degradation fixture (theme.test.ts) — exempt from existence.
  it.each(themes.filter((t) => t !== 'test'))('%s: every sprite reference points at a real file', (theme) => {
    const m = load(theme)
    for (const f of referencedFiles(m)) {
      // Leading-slash refs resolve from the site root (public/), not the theme dir.
      const resolved = f.startsWith('/') ? join(THEMES_DIR, '..', f) : join(THEMES_DIR, theme, f)
      expect(existsSync(resolved), `${theme}/manifest.json references missing ${f}`).toBe(true)
    }
  })

  it.each(themes)('%s: tile pools list EXACTLY the numbered tiles on disk, in numeric order', (theme) => {
    const tilesDir = join(THEMES_DIR, theme, 'tiles')
    if (!existsSync(tilesDir)) return // single-file themes (city/test) have no pools
    const m = load(theme)
    const disk = readdirSync(tilesDir)
    for (const surface of SURFACES) {
      for (const pool of POOLS) {
        const expected = disk
          .map((f) => ({ f, match: pool.pattern(surface).exec(f) }))
          .filter((e): e is { f: string; match: RegExpExecArray } => e.match !== null)
          .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
          .map((e) => `tiles/${e.f}`)
        const listed = (m.sprites?.[pool.key(surface)] ?? []) as string[]
        if (expected.length === 0 && !(pool.key(surface) in (m.sprites ?? {}))) continue
        expect(listed, `${theme}: sprites["${pool.key(surface)}"] vs tiles/ on disk`).toEqual(expected)
      }
    }
  })

  it.each(themes)('%s: macro pools are full multiples of macro² (the engine falls back otherwise)', (theme) => {
    const m = load(theme)
    for (const [surface, macro] of Object.entries(m.macroTiles ?? {})) {
      const pool = (m.sprites?.[`tile.${surface}`] ?? []) as string[]
      const per = macro * macro
      expect(pool.length, `${theme}: tile.${surface} pool smaller than ${macro}×${macro}`).toBeGreaterThanOrEqual(per)
      expect(pool.length % per, `${theme}: tile.${surface} pool (${pool.length}) is a partial macro master`).toBe(0)
    }
  })
})
