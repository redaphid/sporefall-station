// Property sweep: on EVERY mission world, the objective must be reachable by a
// DEFAULT player using available mechanics, and the unlock path must be
// enumerable and affordable. This is the regression fence for the "objectives
// stuck behind locked doors" progression blocker: locks may cost time, never
// the run.
//
// For 100 seeds x floors 1-3 (300 worlds) it asserts:
//   1. every locked door's lock level clamps into the pick table (finite pick
//      time — no lock is unpickable now that class perks are gone),
//   2. BFS from spawn reaches the mission objective through wall-free tiles
//      (doors count as passable BECAUSE every door is pickable/breachable),
//   3. the locked doors actually crossed on that path cost <= 20s of total
//      channeling (the bunker's three serial doors included).

import { describe, expect, it } from 'vitest'
import { spawnPlayer } from '../player'
import { populateWorld } from '../populate'
import { isSolidTile } from '../levelgen/level'
import { createWorld, type World } from '../world'
import { pickTicks, PICK_TICKS_BY_LEVEL } from './interaction'
import { setupFloor } from './missions'

const SEEDS = 100
const FLOORS = [1, 2, 3]
/** Balance budget: total pick-channel ticks crossed en route to the objective. */
const MAX_PATH_PICK_TICKS = 20 * 30

const bootWorld = (seed: number, floor: number): World => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
  return w
}

/** BFS over non-wall tiles; returns the tile path spawn→target or null. */
const findPath = (w: World, tx: number, ty: number): { x: number; y: number }[] | null => {
  const { w: W, h: H } = w.level
  const sx = Math.floor(w.level.spawn.x)
  const sy = Math.floor(w.level.spawn.y)
  const key = (x: number, y: number): number => y * W + x
  const parent = new Map<number, number>()
  parent.set(key(sx, sy), -1)
  let frontier = [key(sx, sy)]
  while (frontier.length > 0) {
    const next: number[] = []
    for (const k of frontier) {
      const x = k % W
      const y = Math.floor(k / W)
      if (x === tx && y === ty) {
        const path: { x: number; y: number }[] = []
        for (let cur = k; cur !== -1; cur = parent.get(cur)!) path.push({ x: cur % W, y: Math.floor(cur / W) })
        return path.reverse()
      }
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const nk = key(nx, ny)
        if (parent.has(nk) || isSolidTile(w.level, nx, ny)) continue
        parent.set(nk, k)
        next.push(nk)
      }
    }
    frontier = next
  }
  return null
}

describe(`mission reachability sweep — ${SEEDS} seeds x floors ${FLOORS.join('/')}`, () => {
  it('every objective is reachable and its unlock path is pickable within budget', () => {
    let missions = 0
    let lockedDoorsSeen = 0
    let maxPathPickTicks = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      for (const floor of FLOORS) {
        const w = bootWorld(seed, floor)
        const ctx = `seed=${seed} floor=${floor}`

        // (1) Every locked door is pickable in finite, table-bounded time.
        const lockedDoors = w.entities.filter((e) => e.door?.locked)
        for (const d of lockedDoors) {
          const t = pickTicks(d.door!.lockLevel)
          expect(t, `${ctx}: unpickable lock level ${d.door!.lockLevel}`).toBeGreaterThan(0)
          expect(t, `${ctx}: pick time off the table`).toBeLessThanOrEqual(PICK_TICKS_BY_LEVEL[PICK_TICKS_BY_LEVEL.length - 1])
        }
        lockedDoorsSeen += lockedDoors.length

        // (2) The objective is reachable from spawn (doors are never walls).
        if (w.mission.targetEntityId === undefined) continue // 'reach' missions have no target
        missions++
        const target = w.byId.get(w.mission.targetEntityId)!
        const path = findPath(w, Math.floor(target.pos.x), Math.floor(target.pos.y))
        expect(path, `${ctx}: mission objective UNREACHABLE from spawn`).not.toBeNull()

        // (3) The locked doors actually on the path fit the channeling budget.
        const doorAt = new Map<string, number>()
        for (const d of lockedDoors) doorAt.set(`${Math.floor(d.pos.x)},${Math.floor(d.pos.y)}`, d.door!.lockLevel)
        const pathTicks = path!.reduce((sum, t) => {
          const lvl = doorAt.get(`${t.x},${t.y}`)
          return lvl === undefined ? sum : sum + pickTicks(lvl)
        }, 0)
        expect(pathTicks, `${ctx}: unlock path costs ${pathTicks} ticks of channeling`).toBeLessThanOrEqual(MAX_PATH_PICK_TICKS)
        maxPathPickTicks = Math.max(maxPathPickTicks, pathTicks)
      }
    }
    // The sweep must actually have exercised the property, not vacuously passed.
    expect(missions).toBeGreaterThan(200)
    expect(lockedDoorsSeen).toBeGreaterThan(300)
    expect(maxPathPickTicks).toBeGreaterThan(0)
  })
})
