import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FURNITURE_SHAPE, PROP_SPRITE, type FurnitureShape } from './art'
import { PROP_NAMES } from './theme'
import { OBJECTS } from '../game/data/objects'
import { NPCS } from '../game/data/npcs'

// Every interior object (and the dormant spore pod NPC) must render as EITHER a
// real themed prop texture (via PROP_SPRITE → a loaded prop) OR a DISTINCT
// procedural silhouette (FURNITURE_SHAPE). Nothing may fall through to the
// character "eyeball" fallback, and nothing that had a decent match should be a
// bare tinted box. This is the regression guard for the "missing prop art" fix.

/** Archetypes that used to render as placeholder boxes / eyeballs. */
const INTERIOR_ARCHETYPES = [...Object.keys(OBJECTS), 'pod']

/** A themed prop key resolves to a real texture only if the theme actually
 * loads a `prop.<name>` for it — i.e. it is a declared PROP_NAME. */
const propKeyResolves = (key: string): boolean => (PROP_NAMES as readonly string[]).includes(key)

const isCovered = (archetype: string): 'sprite' | FurnitureShape | undefined => {
  const propKey = PROP_SPRITE[archetype]
  if (propKey && propKeyResolves(propKey)) return 'sprite'
  // The wooden crate resolves to the default prop sprite (prop.default) and also
  // carries a procedural 'crate' silhouette as a theme-less fallback.
  if (archetype === 'crate') return 'sprite'
  return FURNITURE_SHAPE[archetype]
}

describe('interior prop / furniture art resolution', () => {
  it('every interior archetype resolves to a real sprite or a distinct procedural shape', () => {
    for (const a of INTERIOR_ARCHETYPES) {
      const cover = isCovered(a)
      expect(cover, `${a} must map to a prop sprite or a furniture shape (not the eyeball fallback)`).toBeDefined()
    }
  })

  it('previously-unmapped furniture now draws a DISTINCT shape, never the generic box', () => {
    // These have no acceptable existing sprite, so they must get bespoke geometry.
    const distinct: Record<string, FurnitureShape> = {
      bunk: 'bunk',
      table: 'table',
      bench: 'bench',
      shelf: 'shelf',
      plant: 'plant',
      pod: 'pod',
    }
    for (const [a, shape] of Object.entries(distinct)) {
      expect(FURNITURE_SHAPE[a], `${a} draws a ${shape}`).toBe(shape)
    }
  })

  it('every PROP_SPRITE target is a declared PROP_NAME (so it loads a real texture)', () => {
    for (const [archetype, key] of Object.entries(PROP_SPRITE)) {
      expect(propKeyResolves(key), `PROP_SPRITE[${archetype}] → prop.${key} must be a declared PROP_NAME`).toBe(true)
    }
  })

  it('the classic props still map to their bespoke swampspace sprites', () => {
    expect(PROP_SPRITE.barrel).toBe('barrel')
    expect(PROP_SPRITE.atm).toBe('atm')
    expect(PROP_SPRITE.vending).toBe('vending-machine')
    expect(PROP_SPRITE.tv).toBe('tv')
    expect(PROP_SPRITE.toilet).toBe('toilet')
  })

  it('the newly-mapped furniture reuses an existing themed prop texture', () => {
    // Reuse is expected while bespoke diffusion art is GPU-blocked.
    expect(PROP_SPRITE.locker).toBe('locker')
    expect(PROP_SPRITE.cabinet).toBe('cabinet')
    expect(PROP_SPRITE.desk).toBe('desk')
    expect(PROP_SPRITE.cryoTerminal).toBe('atm')
    expect(PROP_SPRITE.generator).toBe('tv')
  })

  it('the dormant spore pod NPC exists and draws as an egg-pod ovoid', () => {
    expect(NPCS.pod).toBeDefined()
    expect(FURNITURE_SHAPE.pod).toBe('pod')
    expect(FURNITURE_SHAPE.sporeNode).toBe('pod')
  })

  it.each(['swampspace', 'swampspace-hires'])(
    'the %s manifest ships a prop file for every reused prop key',
    (themeId) => {
      const manifest = JSON.parse(
        readFileSync(join(process.cwd(), 'public', 'themes', themeId, 'manifest.json'), 'utf8'),
      )
      // Each distinct prop key used by PROP_SPRITE must be declared as prop.<key>.
      const usedKeys = new Set(Object.values(PROP_SPRITE))
      for (const key of usedKeys) {
        const path = manifest.sprites[`prop.${key}`]
        expect(path, `${themeId} declares prop.${key}`).toBeTruthy()
      }
    },
  )
})
