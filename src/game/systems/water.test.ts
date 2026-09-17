// WATER hazard cells (systems/water.ts) — the third instance of the hazard-cell
// shape fire and spore already share. Adversarial coverage of the design calls
// this feature had to make, each of which is a rule someone could later "fix"
// without realising it was deliberate:
//
//   - water is STATIC (it never spreads), unlike both of its siblings;
//   - a puddle QUENCHES a fire in its cell and pays STEAM_COST fuel for it;
//   - MAX_WATER_CELLS is a hard cap, because every cell is an entity bidding for
//     a slot in a 48-entity snapshot against the enemies actually trying to kill
//     you;
//   - a flooded cell is an ENTITY, never a tile edit — the level must stay
//     regenerable from seed+floor (serialize.ts throws on checksum drift).
//
// Everything below sets exact state and runs the REAL systems (tickWorld /
// waterSystem), never a hand-rolled imitation of them.

import { beforeEach, describe, expect, it } from 'vitest'
import { ELEMENTS } from '../data/elements'
import { makeEntity, type Entity } from '../entity'
import { isSolidTile, levelChecksum } from '../levelgen/level'
import { spawnPlayer } from '../player'
import { deserializeWorld, serializeWorld } from '../serialize'
import { expectWorldEqual, runTicks } from '../testkit'
import { addEntity, createWorld, tickWorld, type World } from '../world'
import { fireAt, igniteCell } from './fire'
import { hasStatus } from './statusFx'
import {
  floodCell,
  flood,
  MAX_WATER_CELLS,
  STEAM_COST,
  waterAt,
  waterCellCount,
  waterSystem,
  WATER_FUEL,
} from './water'

/** Top-left of the first open `rw`×`rh` block, scanned in a fixed order so every
 * test in this file stages itself on exactly the same tiles on every run. */
const findOpenRect = (w: World, rw: number, rh: number): { x: number; y: number } => {
  for (let y = 1; y < w.level.h - rh; y++) {
    for (let x = 1; x < w.level.w - rw; x++) {
      let ok = true
      for (let dy = 0; dy < rh && ok; dy++) {
        for (let dx = 0; dx < rw; dx++) {
          if (isSolidTile(w.level, x + dx, y + dy)) {
            ok = false
            break
          }
        }
      }
      if (ok) return { x, y }
    }
  }
  throw new Error(`no open ${rw}x${rh} area in this level`)
}

/** A still body at a cell centre, with hp so the hazard systems will treat it
 * as something that can be hurt. */
const body = (w: World, tx: number, ty: number, hp = 100): Entity => {
  const e = addEntity(w, makeEntity('npc', 'civilian', tx + 0.5, ty + 0.5))
  e.health = { hp, max: hp, iframes: 0 }
  e.ai = undefined
  return e
}

/** The sorted cell/fuel signature of every live puddle — the determinism probe. */
const waterSignature = (w: World): string =>
  w.entities
    .filter((e) => e.water && !e.dead)
    .map((e) => `${Math.floor(e.pos.x)},${Math.floor(e.pos.y)}:${e.water!.fuel}`)
    .sort()
    .join('|')

describe('water cells — placement and the one-per-cell rule', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('floodCell places one puddle addressed by its cell', () => {
    const { x, y } = findOpenRect(w, 2, 1)
    floodCell(w, x, y)
    expect(waterAt(w, x, y)).toBe(true)
    expect(waterAt(w, x + 1, y)).toBe(false)
  })

  it('is a no-op when the cell already holds water', () => {
    const { x, y } = findOpenRect(w, 1, 1)
    expect(floodCell(w, x, y)).toBeDefined()
    expect(floodCell(w, x, y)).toBeUndefined()
    expect(waterCellCount(w)).toBe(1)
  })

  it('DEGENERATE: refuses a solid tile — water can never stand inside a wall', () => {
    // Find a wall the level really has, rather than trusting a hardcoded coord.
    let wall: { x: number; y: number } | undefined
    for (let y = 0; y < w.level.h && !wall; y++) {
      for (let x = 0; x < w.level.w; x++) {
        if (isSolidTile(w.level, x, y)) {
          wall = { x, y }
          break
        }
      }
    }
    expect(wall, 'the level should contain at least one solid tile').toBeDefined()
    expect(floodCell(w, wall!.x, wall!.y)).toBeUndefined()
    expect(waterCellCount(w)).toBe(0)
  })

  it('flood() floods the cell a body is standing in', () => {
    const { x, y } = findOpenRect(w, 1, 1)
    const e = body(w, x, y)
    flood(w, e)
    expect(waterAt(w, x, y)).toBe(true)
  })

  it('THE SNAPSHOT BUDGET: MAX_WATER_CELLS is a hard cap, not a suggestion', () => {
    // Ask for far more cells than the cap allows, from a caller that ignores the
    // return value — the cap has to hold anyway, because a boss flooding a cell
    // per step is exactly the caller that will do this.
    const { x, y } = findOpenRect(w, 8, 6)
    let granted = 0
    for (let dy = 0; dy < 6; dy++) {
      for (let dx = 0; dx < 8; dx++) {
        if (floodCell(w, x + dx, y + dy)) granted++
      }
    }
    expect(granted).toBe(MAX_WATER_CELLS)
    expect(waterCellCount(w)).toBe(MAX_WATER_CELLS)
    // 48 entities is the whole snapshot; a flood may never bid for more than half.
    expect(MAX_WATER_CELLS * 2).toBeLessThanOrEqual(48)
  })

  it('a cell freed by evaporation lets a later flood back under the cap', () => {
    const { x, y } = findOpenRect(w, 8, 6)
    for (let dy = 0; dy < 6; dy++) for (let dx = 0; dx < 8; dx++) floodCell(w, x + dx, y + dy)
    expect(floodCell(w, x, y + 5)).toBeUndefined() // capped out
    // Dry one cell and the budget frees up again.
    const victim = w.entities.find((e) => e.water)!
    victim.water!.fuel = 1
    tickWorld(w, new Map())
    expect(waterCellCount(w)).toBe(MAX_WATER_CELLS - 1)
    expect(floodCell(w, x, y + 5)).toBeDefined()
  })
})

describe('water cells — soaking, drying, and staying put', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('lays `wet` on a body standing in it, through the real tickWorld', () => {
    const { x, y } = findOpenRect(w, 2, 1)
    const e = body(w, x, y)
    floodCell(w, x, y)
    expect(hasStatus(e, 'wet')).toBe(false)
    tickWorld(w, new Map())
    expect(hasStatus(e, 'wet')).toBe(true)
    expect(e.fx!.wet.until).toBe(ELEMENTS.wet.durationTicks) // applied at tick 0
  })

  it('does NOT wet a body in the neighbouring cell', () => {
    const { x, y } = findOpenRect(w, 2, 1)
    const dry = body(w, x + 1, y)
    floodCell(w, x, y)
    tickWorld(w, new Map())
    expect(hasStatus(dry, 'wet')).toBe(false)
  })

  it('the soak REFRESHES while you stand in it, so wading never dries out mid-pool', () => {
    const { x, y } = findOpenRect(w, 2, 1)
    const e = body(w, x, y)
    floodCell(w, x, y)
    runTicks(w, new Map(), 100)
    // `wet` is a plain (non-immobilize) status, so reapplication refreshes it:
    // the expiry keeps sliding forward rather than counting down to zero.
    expect(e.fx!.wet.until).toBe(w.tick - 1 + ELEMENTS.wet.durationTicks)
  })

  it('a DOWNED body standing in water is still soaked (no exemption here)', () => {
    const { x, y } = findOpenRect(w, 2, 2)
    const p = spawnPlayer(w, 0, x + 0.5, y + 0.5)
    p.health!.iframes = 0
    p.playerCtl!.downed = { bleedTicks: 9999, reviveProgress: 0 }
    floodCell(w, x, y)
    tickWorld(w, new Map())
    // The downed protection is a SHOCK-damage rule and lives in interactions.ts;
    // restating it here as "downed bodies don't get wet" would be a second,
    // divergent copy of one guarantee.
    expect(hasStatus(p, 'wet')).toBe(true)
  })

  it('STATIC: a puddle never spreads, however long it sits', () => {
    const { x, y } = findOpenRect(w, 5, 5)
    floodCell(w, x + 2, y + 2)
    const before = waterSignature(w)
    runTicks(w, new Map(), 200)
    expect(waterCellCount(w)).toBe(1) // fire and spore would have crawled by now
    expect(waterAt(w, x + 2, y + 2)).toBe(true)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      expect(waterAt(w, x + 2 + dx, y + 2 + dy), `spread to ${dx},${dy}`).toBe(false)
    }
    // Only the fuel moved.
    expect(before).not.toBe(waterSignature(w))
  })

  it('dries down and evaporates once its fuel runs out', () => {
    const { x, y } = findOpenRect(w, 1, 1)
    floodCell(w, x, y)
    runTicks(w, new Map(), WATER_FUEL - 1)
    expect(waterAt(w, x, y)).toBe(true)
    runTicks(w, new Map(), 2)
    expect(waterAt(w, x, y)).toBe(false)
    expect(waterCellCount(w)).toBe(0)
  })
})

describe('fire meets water — the deliberate call: the water wins and pays for it', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('a puddle quenches a fire in its own cell and is charged STEAM_COST', () => {
    const { x, y } = findOpenRect(w, 3, 1)
    igniteCell(w, x, y)
    floodCell(w, x, y)
    tickWorld(w, new Map())
    expect(fireAt(w, x, y)).toBe(false)
    const puddle = w.entities.find((e) => e.water)!
    expect(puddle.water!.fuel).toBe(WATER_FUEL - STEAM_COST - 1) // steam, then the tick's own dry-down
  })

  it('the same holds when the fire is lit INTO standing water (order does not matter)', () => {
    const { x, y } = findOpenRect(w, 3, 1)
    floodCell(w, x, y)
    igniteCell(w, x, y)
    tickWorld(w, new Map())
    expect(fireAt(w, x, y)).toBe(false)
    expect(w.entities.find((e) => e.water)!.water!.fuel).toBe(WATER_FUEL - STEAM_COST - 1)
  })

  it('a fire in the NEXT cell burns on untouched — quenching is per-cell', () => {
    const { x, y } = findOpenRect(w, 3, 1)
    floodCell(w, x, y)
    igniteCell(w, x + 1, y)
    tickWorld(w, new Map())
    expect(fireAt(w, x + 1, y)).toBe(true)
    expect(w.entities.find((e) => e.water)!.water!.fuel).toBe(WATER_FUEL - 1) // no steam charged
  })

  it('ADVERSARIAL: enough fires dry the puddle out — water is not an invincible ward', () => {
    const { x, y } = findOpenRect(w, 3, 1)
    const puddle = floodCell(w, x, y)!
    // Feed it fires until the steam bill exceeds its fuel.
    for (let i = 0; i < Math.ceil(WATER_FUEL / STEAM_COST) + 1; i++) {
      igniteCell(w, x, y)
      tickWorld(w, new Map())
    }
    expect(puddle.dead).toBe(true)
    expect(waterAt(w, x, y)).toBe(false)
  })

  it('a burning body walking into water keeps its `burning` status — dousing bodies is the ROLL verb', () => {
    // Deliberate scope line: water quenches the GROUND, not people. Stop-drop-
    // and-roll (systems/roll.ts DOUSE_TICKS) owns putting a body out, and giving
    // water that power too would silently retire the roll's best use.
    const { x, y } = findOpenRect(w, 2, 1)
    const e = body(w, x, y)
    e.fx = { burning: { until: 500 } }
    floodCell(w, x, y)
    tickWorld(w, new Map())
    expect(hasStatus(e, 'burning')).toBe(true)
    expect(hasStatus(e, 'wet')).toBe(true)
  })
})

describe('water cells — determinism and lossless round-trip', () => {
  it('is deterministic: same seed and script yields an identical pool', () => {
    const run = (): string => {
      const world = createWorld(7, 1)
      const { x, y } = findOpenRect(world, 4, 2)
      floodCell(world, x, y)
      floodCell(world, x + 1, y)
      igniteCell(world, x + 1, y)
      body(world, x, y)
      runTicks(world, new Map(), 40)
      return waterSignature(world)
    }
    expect(run()).toBe(run())
  })

  it('THE SIM NEVER MUTATES TILES: flooding leaves the level checksum untouched', () => {
    const w = createWorld(3, 1)
    const before = levelChecksum(w.level)
    const { x, y } = findOpenRect(w, 4, 4)
    for (let dx = 0; dx < 4; dx++) floodCell(w, x + dx, y)
    runTicks(w, new Map(), 30)
    expect(levelChecksum(w.level)).toBe(before)
    // And the snapshot still restores, which is the guarantee the checksum backs:
    // deserializeWorld THROWS on drift, so this would be loud rather than subtle.
    expect(() => deserializeWorld(serializeWorld(w))).not.toThrow()
  })

  it('a world containing water round-trips byte-for-byte and replays identically', () => {
    const w = createWorld(5, 1)
    const { x, y } = findOpenRect(w, 4, 2)
    for (let dx = 0; dx < 3; dx++) floodCell(w, x + dx, y)
    body(w, x + 1, y)
    runTicks(w, new Map(), 20) // mid-life: partially dried, bodies already soaked

    const json = serializeWorld(w)
    const saved = JSON.parse(JSON.stringify(json)) as typeof json
    const cell = saved.entities.find((e) => e.water) as Record<string, unknown> | undefined
    expect(cell, 'the puddle must survive into the snapshot').toBeDefined()
    expect(cell!.archetype).toBe('water')

    // Byte-for-byte: re-serializing the restored world reproduces the same JSON.
    const restored = deserializeWorld(json)
    expect(serializeWorld(restored)).toEqual(json)

    // …and both restored copies stay equal to each other AND to the live world.
    const a = deserializeWorld(json)
    const b = deserializeWorld(json)
    runTicks(a, new Map(), 60)
    runTicks(b, new Map(), 60)
    expectWorldEqual(a, b)
    runTicks(w, new Map(), 60)
    expectWorldEqual(w, a)
  })

  it('OMITTED WHEN UNSET: nothing that is not water carries a `water` key', () => {
    const w = createWorld(1, 1)
    const { x, y } = findOpenRect(w, 2, 1)
    const e = body(w, x + 1, y)
    floodCell(w, x, y)
    const json = serializeWorld(w)
    const plain = json.entities.find((s) => s.id === e.id)!
    expect('water' in plain).toBe(false)
    expect(json.entities.filter((s) => 'water' in s).length).toBe(1)
  })

  it('a world with no water serializes exactly as it did before this feature', () => {
    const w = createWorld(9, 1)
    runTicks(w, new Map(), 5)
    for (const s of serializeWorld(w).entities) expect('water' in s).toBe(false)
  })
})

describe('waterSystem — cost and guards', () => {
  it('costs nothing on a floor with no water', () => {
    const w = createWorld(2, 1)
    const before = serializeWorld(w)
    waterSystem(w) // early-returns before touching a single entity
    expect(serializeWorld(w)).toEqual(before)
  })

  it('puddles never soak each other (a cell is an entity too)', () => {
    const w = createWorld(1, 1)
    const { x, y } = findOpenRect(w, 3, 1)
    floodCell(w, x, y)
    floodCell(w, x + 1, y)
    runTicks(w, new Map(), 5)
    for (const e of w.entities) if (e.water) expect(e.fx).toBeUndefined()
  })
})
