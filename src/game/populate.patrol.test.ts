import { describe, expect, it } from 'vitest'
import { generateLevel } from './levelgen/generate'
import type { Building } from './levelgen/level'
import { populateWorld } from './populate'
import { setupFloor } from './systems/missions'
import { createWorld, tickWorld, type World } from './world'
import type { Entity } from './entity'
import type { Rect } from './levelgen/rooms'

/**
 * Integration: the set-piece patrol beats (bunker guard band, courtyard pit)
 * actually WORK when the real systems run — the patroller advances waypoints
 * instead of wedging on airlock flanks or chamber walls (patrol steering is
 * straight-line, no pathfinder, so the beat must be provably open).
 */

const findCase = (poi: Building['poi']): { seed: number; floor: number } => {
  for (let seed = 1; seed <= 100; seed++) {
    for (let floor = 2; floor <= 4; floor++) {
      if (generateLevel(seed, floor).buildings.some((b) => b.poi === poi)) return { seed, floor }
    }
  }
  throw new Error(`no ${poi} found in search bound`)
}

/** Peaceful world (hostile=false, no players) so ambient patrol is never
 * outranked by threat-tier goals — pure patrol behavior under test. */
const buildWorld = (seed: number, floor: number): World => {
  const w = createWorld(seed, floor, 'normal', false)
  populateWorld(w)
  setupFloor(w)
  return w
}

const patrollerIn = (w: World, b: Building): Entity | undefined =>
  w.entities.filter((e) => e.ai?.behavior === 'patrol').find(
    (e) =>
      e.pos.x >= b.rect.x && e.pos.x <= b.rect.x + b.rect.w && e.pos.y >= b.rect.y && e.pos.y <= b.rect.y + b.rect.h,
  )

const inside = (r: Rect, x: number, y: number, slack = 0): boolean =>
  x >= r.x - slack && x <= r.x + r.w + slack && y >= r.y - slack && y <= r.y + r.h + slack

const runTicks = (w: World, n: number): void => {
  for (let i = 0; i < n; i++) tickWorld(w, new Map())
}

describe('set-piece patrols', () => {
  it('a bunker guard circles the guard band without wedging or entering the chamber', () => {
    const { seed, floor } = findCase('bunker')
    const w = buildWorld(seed, floor)
    const bunker = w.level.buildings.find((b) => b.poi === 'bunker')!
    const guard = patrollerIn(w, bunker)
    expect(guard, 'bunker has a patrolling guard').toBeDefined()
    const band = bunker.rooms[0]
    const core = bunker.rooms[bunker.rooms.length - 1]
    const visited = new Set<number>()
    for (let step = 0; step < 40; step++) {
      runTicks(w, 30)
      visited.add(guard!.ai!.patrolIndex ?? 0)
      expect(inside(band, guard!.pos.x, guard!.pos.y), `guard left the band at ${guard!.pos.x},${guard!.pos.y}`).toBe(true)
      expect(inside(core, guard!.pos.x, guard!.pos.y), 'guard inside the sealed chamber').toBe(false)
    }
    // A full circuit: every corner of the beat reached within ~40s of sim.
    expect(visited.size, `only visited waypoints ${[...visited]}`).toBe(4)
  })

  it('a courtyard compound NPC does rounds of the pit', () => {
    const { seed, floor } = findCase('courtyard')
    const w = buildWorld(seed, floor)
    const compound = w.level.buildings.find((b) => b.poi === 'courtyard' && b.courtyard)!
    const walker = patrollerIn(w, compound)
    expect(walker, 'compound has a pit patroller').toBeDefined()
    const pit = compound.courtyard!
    const visited = new Set<number>()
    for (let step = 0; step < 40; step++) {
      runTicks(w, 30)
      visited.add(walker!.ai!.patrolIndex ?? 0)
      expect(inside(pit, walker!.pos.x, walker!.pos.y, 0.5), `walker left the pit at ${walker!.pos.x},${walker!.pos.y}`).toBe(true)
    }
    expect(visited.size, `only visited waypoints ${[...visited]}`).toBe(4)
  })
})
