import { describe, expect, it } from 'vitest'
import { generateLevel } from '../levelgen/generate'
import type { Building } from '../levelgen/level'
import { createWorld } from '../world'
import { setupFloor } from './missions'

/**
 * Mission placement is bunker-aware: when the mission's target building is a
 * bunker, the objective (briefcase or boss) must sit in the bunker's INNERMOST
 * chamber — the last room, behind the airlock and the chamber ring — and all
 * of the bunker's doors (airlock outer+inner, chamber) spawn locked.
 */

/** Mirror of missions.ts farthestBuilding, on the raw level. */
const farthest = (level: ReturnType<typeof generateLevel>): Building | null => {
  let best: Building | null = null
  let bestDist = -1
  for (const b of level.buildings) {
    const cx = b.rect.x + b.rect.w / 2
    const cy = b.rect.y + b.rect.h / 2
    const d = Math.hypot(cx - level.spawn.x, cy - level.spawn.y)
    if (d > bestDist) {
      best = b
      bestDist = d
    }
  }
  return best
}

const bunkerMissionCases = (): { seed: number; floor: number }[] => {
  const cases: { seed: number; floor: number }[] = []
  for (let seed = 1; seed <= 300 && cases.length < 6; seed++) {
    for (let floor = 2; floor <= 4 && cases.length < 6; floor++) {
      const level = generateLevel(seed, floor)
      if (farthest(level)?.poi === 'bunker') cases.push({ seed, floor })
    }
  }
  return cases
}

describe('bunker mission placement', () => {
  it('the objective spawns inside the innermost chamber, doors locked', () => {
    const cases = bunkerMissionCases()
    // If this ever hits 0 the search bound is too small or bunkers vanished.
    expect(cases.length).toBeGreaterThan(0)
    for (const { seed, floor } of cases) {
      const w = createWorld(seed, floor)
      setupFloor(w)
      const tag = `seed ${seed} floor ${floor}`
      expect(w.mission.template, tag).not.toBe('reach')
      const building = w.level.buildings[w.mission.targetBuilding!]
      expect(building.poi, tag).toBe('bunker')
      const target = w.byId.get(w.mission.targetEntityId!)
      expect(target, tag).toBeDefined()
      const core = building.rooms[building.rooms.length - 1]
      expect(target!.pos.x, tag).toBeGreaterThanOrEqual(core.x)
      expect(target!.pos.x, tag).toBeLessThanOrEqual(core.x + core.w)
      expect(target!.pos.y, tag).toBeGreaterThanOrEqual(core.y)
      expect(target!.pos.y, tag).toBeLessThanOrEqual(core.y + core.h)
      // Every bunker door entity spawned locked (airlock pair + chamber door).
      const doorEntities = w.entities.filter(
        (e) => e.door && building.doors.some((d) => d.x === Math.floor(e.pos.x) && d.y === Math.floor(e.pos.y)),
      )
      expect(doorEntities.length, tag).toBe(3)
      for (const d of doorEntities) expect(d.door!.locked, tag).toBe(true)
    }
  })
})
