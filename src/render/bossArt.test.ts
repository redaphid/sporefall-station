// THE DURABLE GUARD AGAINST "the boss draws at thug size".
//
// docs/assets/boss-art-brief.md records the cost of getting this wrong once:
// the Mireclaw Alpha borrowed the thug's body at the thug's size, and that was
// "the single largest reason the owner cleared roughly six boss floors and
// reported never having met a boss". `ARCHETYPE_SCALE.boss = 1.5` fixed the
// Alpha — as a one-off constant, which fixes exactly one boss.
//
// The Vigil then shipped with NO entry at all and inherited the `?? 1` default
// in sprites.ts, reproducing the same failure for the game's second boss. This
// file is the fix that generalises: a boss registered in `data/bosses.ts` with
// no scale, or no colour, fails HERE — at merge time, in a test naming the
// playtest it would otherwise repeat — instead of silently on a boss floor.
//
// It is deliberately driven off `BOSSES` rather than a hand-listed array, so
// the four bosses still on the design doc's list (Echo, the Sealkeeper,
// Mirefather, the Hollow Choir) are covered the moment their row lands.

import { describe, expect, it } from 'vitest'
import { ARCHETYPE_SCALE, ENTITY_COLORS } from './art'
import { BOSSES } from '../game/data/bosses'

/** Below this the size difference is invisible where it matters: a 48px sprite
 * on a 32px tile moves by ~12px at 1.25, and by ~2px at 1.05. A scale that
 * rounds away at play distance is the same bug wearing a number. */
const MIN_BOSS_SCALE = 1.25

const bossArchetypes = Object.keys(BOSSES)

describe('every registered boss is visibly a boss', () => {
  it('has an ARCHETYPE_SCALE entry — never the silent `?? 1` thug-size default', () => {
    for (const archetype of bossArchetypes) {
      expect(
        ARCHETYPE_SCALE[archetype],
        `boss "${archetype}" has no ARCHETYPE_SCALE entry, so sprites.ts draws it at 1 — ` +
          `the exact size of a thug. See docs/assets/boss-art-brief.md.`,
      ).toBeDefined()
    }
  })

  it('is scaled UP by an amount that actually reads on screen', () => {
    for (const archetype of bossArchetypes) {
      expect(ARCHETYPE_SCALE[archetype], `boss "${archetype}" must draw at >= ${MIN_BOSS_SCALE}x`).toBeGreaterThanOrEqual(
        MIN_BOSS_SCALE,
      )
    }
  })

  it('has an ENTITY_COLORS entry — never the 0xcccccc default blob', () => {
    // The other half of the same failure: an archetype with no colour draws as
    // the generic grey eyeball ("the boss spawns white circles", shipped once).
    for (const archetype of bossArchetypes) {
      expect(ENTITY_COLORS[archetype], `boss "${archetype}" has no ENTITY_COLORS entry`).toBeDefined()
      expect(ENTITY_COLORS[archetype]).not.toBe(ENTITY_COLORS.default)
    }
  })

  it('never shares a colour with another boss or with the thug', () => {
    // Two bosses that read as the same creature is the brief's failure mode one
    // level up — and the thug is the specific body the Alpha was mistaken for.
    const seen = new Map<number, string>()
    for (const archetype of bossArchetypes) {
      const color = ENTITY_COLORS[archetype]
      expect(color, `boss "${archetype}" is the thug's colour`).not.toBe(ENTITY_COLORS.thug)
      const clash = seen.get(color)
      expect(clash, `bosses "${archetype}" and "${clash}" share colour ${color.toString(16)}`).toBeUndefined()
      seen.set(color, archetype)
    }
  })

  it('pins the two shipped silhouettes, and the ladder between them', () => {
    // Not redundant with the sweeps above: these are the tuned numbers the art
    // brief and the ARCHETYPE_SCALE comment argue for, and a later "tidy-up"
    // that flattened them would still pass a >= check.
    expect(ARCHETYPE_SCALE.boss).toBe(1.5)
    expect(ARCHETYPE_SCALE.vigil).toBe(2.25) // 1.5 applied twice — one rung up the same ladder
    expect(ARCHETYPE_SCALE.vigil).toBeGreaterThan(ARCHETYPE_SCALE.boss)
  })
})
