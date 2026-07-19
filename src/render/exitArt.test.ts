// The exit tile must be VISIBLE in every shipped theme. The mission chain ends
// at "reach the exit": once the objective is done, the marker/compass points at
// the exit tile — if a theme shipped no exit art and no palette colour, the
// player would be led to a patch of apparently empty ground (exactly what a
// mission-marker bug feels like). Guard the contract at the manifest level:
// every theme in public/themes/index.json must either map `tile.exit` to a real
// sprite file or inherit a visible fallback (palette colour / procedural gold).
import { readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const THEMES_DIR = join(__dirname, '../../public/themes')

interface Manifest {
  sprites?: Record<string, unknown>
  palette?: { tiles?: Record<string, string> }
}

const shippedThemes = (): { id: string }[] => JSON.parse(readFileSync(join(THEMES_DIR, 'index.json'), 'utf8'))

describe('exit tile art — every shipped theme', () => {
  for (const t of shippedThemes()) {
    it(`theme "${t.id}" renders a visible exit tile`, () => {
      const manifestPath = join(THEMES_DIR, t.id, 'manifest.json')
      const m: Manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {}
      const spriteVal = m.sprites?.['tile.exit']
      if (spriteVal !== undefined && spriteVal !== null) {
        // Sprite-mapped: every variant file must exist and be a real PNG.
        const variants = Array.isArray(spriteVal) ? spriteVal : [spriteVal]
        expect(variants.length, `${t.id}: empty tile.exit variant pool`).toBeGreaterThan(0)
        for (const rel of variants) {
          expect(typeof rel, `${t.id}: non-string tile.exit entry`).toBe('string')
          const p = (rel as string).startsWith('/')
            ? join(__dirname, '../../public', rel as string)
            : join(THEMES_DIR, t.id, rel as string)
          expect(existsSync(p), `${t.id}: tile.exit sprite missing on disk: ${rel}`).toBe(true)
          // A visible tile is at least a plausible PNG, not a 0-byte stub.
          expect(statSync(p).size, `${t.id}: tile.exit sprite is a stub: ${rel}`).toBeGreaterThan(80)
        }
      } else {
        // No sprite (or explicit procedural opt-out): the procedural fallback
        // draws the exit from the theme palette colour, falling back per-key to
        // the built-in gold (art.ts TILE_COLORS). Assert the EFFECTIVE colours:
        // the exit must not end up painted like the ground it sits on — that is
        // an invisible exit, which reads as "the marker points at nothing".
        const tiles = m.palette?.tiles ?? {}
        if (tiles.exit !== undefined) expect(tiles.exit, `${t.id}: malformed exit colour`).toMatch(/^#[0-9a-fA-F]{6}$/)
        const effExit = (tiles.exit ?? '#d4af37').toLowerCase() // built-in gold fallback
        expect(effExit, `${t.id}: exit colour equals street colour — invisible exit`).not.toBe(tiles.street?.toLowerCase())
        expect(effExit, `${t.id}: exit colour equals sidewalk colour — invisible exit`).not.toBe(tiles.sidewalk?.toLowerCase())
      }
    })
  }
})
