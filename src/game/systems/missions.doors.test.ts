// A doorway two buildings share gets ONE door. Station modules share walls, and
// both modules list the doorway between them; two door entities stacked on one
// tile were a softlock, because a press only ever toggles the first of them.

import { describe, expect, it } from 'vitest'
import { levelFromJson } from '../levelgen/levelText'
import type { Building } from '../levelgen/level'
import { spawnPlayer } from '../player'
import { populateWorld } from '../populate'
import { runTicks } from '../testkit'
import { createWorld, worldFromState, type World } from '../world'
import { setupFloor } from './missions'

// Three rooms in a row. A|B share the doorway at x=5, B|C the one at x=10.
// The player starts in A; C is the farthest building, so it is the mission's.
const ROWS = [
  '################',
  '#....#....#....#',
  '#.@............#',
  '#....#....#....#',
  '################',
]

const room = (x: number): Building['rooms'][number] => ({ x: x + 1, y: 1, w: 4, h: 3 })
const BUILDINGS: Building[] = [
  { rect: { x: 0, y: 0, w: 6, h: 5 }, rooms: [room(0)], doors: [{ x: 5, y: 2 }], role: 'quarters' },
  { rect: { x: 5, y: 0, w: 6, h: 5 }, rooms: [room(5)], doors: [{ x: 5, y: 2 }, { x: 10, y: 2 }], role: 'mess' },
  { rect: { x: 10, y: 0, w: 6, h: 5 }, rooms: [room(10)], doors: [{ x: 10, y: 2 }], role: 'lab' },
]

const authoredRow = (): World => {
  const w = worldFromState({ level: levelFromJson({ rows: ROWS, buildings: BUILDINGS }) })
  setupFloor(w)
  return w
}

const doorsAt = (w: World, x: number, y: number) =>
  w.entities.filter((e) => e.door && Math.floor(e.pos.x) === x && Math.floor(e.pos.y) === y)

describe('shared doorways', () => {
  it('get exactly one door entity each', () => {
    const w = authoredRow()
    expect(doorsAt(w, 5, 2)).toHaveLength(1)
    expect(doorsAt(w, 10, 2)).toHaveLength(1)
    expect(w.entities.filter((e) => e.door)).toHaveLength(2)
  })

  it("take the mission building's lock when one side is the mission building", () => {
    const w = authoredRow()
    expect(w.mission.targetBuilding).toBe(2)
    expect(doorsAt(w, 10, 2)[0].door).toMatchObject({ open: false, locked: true })
    expect(doorsAt(w, 5, 2)[0].door).toMatchObject({ open: false, locked: false })
  })

  it('open with one press, and the player walks through', () => {
    const w = authoredRow()
    const p = spawnPlayer(w, 0, 2.5, 2.5)
    runTicks(w, new Map([[0, { moveX: 1 }]]), 40)
    expect(p.pos.x, 'the shut door stops the walk').toBeLessThan(5)
    runTicks(w, new Map([[0, { interact: true }]]), 1)
    expect(doorsAt(w, 5, 2)[0].door!.open).toBe(true)
    runTicks(w, new Map([[0, { moveX: 1 }]]), 40)
    expect(p.pos.x, 'through the doorway into B').toBeGreaterThan(6)
  })

  it('on every generated station floor, no tile ever holds two doors', () => {
    for (let seed = 1; seed <= 25; seed++) {
      for (const floor of [3, 4, 5, 6]) {
        const w = createWorld(seed, floor)
        populateWorld(w)
        setupFloor(w)
        const seen = new Set<number>()
        for (const e of w.entities) {
          if (!e.door) continue
          const key = Math.floor(e.pos.y) * w.level.w + Math.floor(e.pos.x)
          expect(seen.has(key), `seed ${seed} floor ${floor}: two doors at (${Math.floor(e.pos.x)},${Math.floor(e.pos.y)})`).toBe(false)
          seen.add(key)
        }
      }
    }
  })
})
