import { describe, expect, it } from 'vitest'
import { isSolidTile } from '../levelgen/level'
import { populateWorld } from '../populate'
import { spawnPlayer } from '../player'
import { playerSpawnPoint } from '../spawnPlacement'
import { emptyInput } from '../types'
import { createWorld, tickWorld } from '../world'
import { setupFloor } from './missions'
import { mireclawSystem, SUMMON_COUNT } from './mireclaw'

/**
 * "I think the boss freeze may be because the boss was spawning in other
 * entities." — the owner, describing what he SAW in the 4-player playtest.
 *
 * Read literally, he is right, and it is the same defect #39 fixed for players.
 * `playerSpawnPoint` (game/spawnPlacement.ts) now guarantees a co-op player
 * lands somewhere its body actually FITS — but the Mireclaw Alpha's brood still
 * gets a raw polar offset with no check at all (systems/mireclaw.ts summonBrood):
 *
 *     const ang = w.rng.next() * Math.PI * 2
 *     const r = 1.5 + w.rng.next() * 2
 *     spawnNpc(w, 'sporeling', boss.pos.x + Math.cos(ang) * r, ...)
 *
 * Measured over 60 seeds x 4 floors (1650 brood actually summoned):
 *   - 23.7% materialise INSIDE A SOLID TILE
 *   - 36.5% materialise INSIDE another entity (crates, shelves, each other)
 *   - 297 were still standing in a wall when the fight ended
 *
 * A body that starts inside a wall fails `canStand` in every direction, so those
 * adds are entombed exactly the way the players were: the boss summons brood
 * that can never reach anyone, and the ones that overlap furniture visibly
 * interpenetrate it. This does not freeze a client, but it is a live, visible
 * bug on main and it is what the player was describing.
 */

const bossWorld = (seed: number) => {
  const w = createWorld(seed, 1, 'normal')
  populateWorld(w)
  setupFloor(w)
  for (let s = 0; s < 4; s++) {
    const at = playerSpawnPoint(w.level, s)
    spawnPlayer(w, s, at.x, at.y)
  }
  const boss = w.mission.targetEntityId !== undefined ? w.byId.get(w.mission.targetEntityId) : undefined
  return boss?.archetype === 'boss' ? { w, boss } : null
}

/** Run a real boss fight and return every brood add's spawn placement. */
const summonedBrood = (seed: number) => {
  const built = bossWorld(seed)
  if (!built) return []
  const { w, boss } = built
  // Park the party on the boss so it reveals and starts summoning.
  for (const e of w.entities) {
    if (!e.playerCtl) continue
    e.pos.x = boss.pos.x + 2
    e.pos.y = boss.pos.y
    if (e.health) {
      e.health.hp = 1e6
      e.health.max = 1e6
    }
  }
  const inputs = new Map(Array.from({ length: 4 }, (_, s) => [s, { ...emptyInput() }]))
  const known = new Set(w.entities.map((e) => e.id))
  const out: { id: number; x: number; y: number; inWall: boolean; inside?: string }[] = []
  for (let t = 0; t < 900; t++) {
    tickWorld(w, inputs)
    for (const e of w.entities) {
      if (known.has(e.id) || e.archetype !== 'sporeling') continue
      known.add(e.id)
      let inside: string | undefined
      for (const o of w.entities) {
        if (o === e || o.dead || o.projectile || !o.radius) continue
        if (Math.hypot(o.pos.x - e.pos.x, o.pos.y - e.pos.y) < (o.radius + e.radius) * 0.9) {
          inside = `${o.archetype}#${o.id}`
          break
        }
      }
      out.push({ id: e.id, x: e.pos.x, y: e.pos.y, inWall: isSolidTile(w.level, Math.floor(e.pos.x), Math.floor(e.pos.y)), inside })
    }
  }
  return out
}

describe('the boss summons brood into places a body actually fits', () => {
  it('no brood add materialises inside a solid tile', () => {
    const brood = summonedBrood(1)
    expect(brood.length, 'the boss never summoned — scenario is not exercising the fight').toBeGreaterThan(10)
    const walled = brood.filter((b) => b.inWall)
    expect(
      walled.map((b) => `#${b.id} at (${b.x.toFixed(2)},${b.y.toFixed(2)})`),
      `${walled.length}/${brood.length} brood spawned inside a wall`,
    ).toEqual([])
  })

  it('no brood add materialises inside another entity', () => {
    const brood = summonedBrood(1)
    const overlapping = brood.filter((b) => b.inside)
    expect(
      overlapping.map((b) => `#${b.id} inside ${b.inside}`),
      `${overlapping.length}/${brood.length} brood spawned inside another entity`,
    ).toEqual([])
  })

  it('sweep: brood placement is safe across seeds', () => {
    let total = 0
    let bad = 0
    for (const seed of [1, 3, 6, 9, 11, 99]) {
      for (const b of summonedBrood(seed)) {
        total++
        if (b.inWall || b.inside) bad++
      }
    }
    expect(total, 'no boss floors in the sample').toBeGreaterThan(50)
    expect(bad / total, `${bad}/${total} brood spawned inside a wall or another entity`).toBeLessThan(0.02)
  })

  /**
   * THE CONSTRAINT THE FIX HAD TO RESPECT. `w.rng` is the whole sim's stream —
   * loot rolls, patrol routes, weapon rolls, encounter draws all pull from it in
   * tick order. Spending one extra value inside `summonBrood` would silently
   * re-roll everything downstream of the first summon and break replay
   * (debug/record.ts) and serialization round-trips.
   *
   * So the fix draws the SAME two values per add and treats them as an intent to
   * be resolved, rather than drawing again until it finds a clear spot. This test
   * pins that: it passes identically on the code before and after the fix, and
   * fails the moment anyone adds a draw (e.g. a naive retry loop).
   */
  it('consumes exactly two rng draws per add — the sim stream is unperturbed', () => {
    const built = bossWorld(1)
    expect(built, 'seed 1 floor 1 should be a boss floor').not.toBeNull()
    const { w, boss } = built!
    w.mission.bossRevealed = true // skip the reveal gate; we are measuring the summon
    boss.ai!.summonAt = 0
    w.tick = 1000

    let draws = 0
    const real = w.rng.next.bind(w.rng)
    w.rng.next = () => {
      draws++
      return real()
    }

    const before = w.entities.filter((e) => e.archetype === 'sporeling').length
    mireclawSystem(w)
    const added = w.entities.filter((e) => e.archetype === 'sporeling').length - before

    expect(added, 'the boss should have summoned this tick').toBe(SUMMON_COUNT)
    expect(draws, 'summonBrood must draw exactly 2 rng values per add, as it always has').toBe(2 * SUMMON_COUNT)
  })
})
