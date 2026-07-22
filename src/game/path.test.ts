// A* pathfinder — adversarial TDD. The invariants that make routing safe for
// the sim: never crosses solid, 4-connected steps only, deterministic output,
// door semantics (closed-unlocked = costed pass-through, locked = wall),
// bounded exploration, graceful failure on unreachable / degenerate queries.

import { describe, expect, it } from 'vitest'
import { Tile, isSolidTile } from './levelgen/level'
import { DOOR_COST, findPath } from './path'
import { createWorld } from './world'
import type { Level } from './levelgen/level'
import type { Vec2 } from './types'

const carve = (level: Level, x0: number, y0: number, x1: number, y1: number): void => {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      level.tiles[y * level.w + x] = Tile.Floor
      level.solid[y * level.w + x] = 0
    }
  }
}

const wall = (level: Level, x: number, y: number): void => {
  level.tiles[y * level.w + x] = Tile.Wall
  level.solid[y * level.w + x] = 1
}

/** A level that is ALL wall except what the test carves — full control. */
const blank = (): Level => {
  const level = createWorld(1, 1).level
  level.tiles.fill(Tile.Wall)
  level.solid.fill(1)
  return level
}

const key = (level: Level, x: number, y: number): number => Math.floor(y) * level.w + Math.floor(x)

/** The safety invariant: every node open, consecutive nodes orthogonally adjacent. */
const assertWellFormed = (level: Level, path: Vec2[], from: Vec2): void => {
  let prev = { x: Math.floor(from.x), y: Math.floor(from.y) }
  for (const n of path) {
    const tx = Math.floor(n.x)
    const ty = Math.floor(n.y)
    expect(isSolidTile(level, tx, ty), `path crosses solid at ${tx},${ty}`).toBe(false)
    expect(n.x).toBeCloseTo(tx + 0.5, 9) // tile-centre waypoints
    expect(n.y).toBeCloseTo(ty + 0.5, 9)
    const step = Math.abs(tx - prev.x) + Math.abs(ty - prev.y)
    expect(step, `non-adjacent step ${prev.x},${prev.y} -> ${tx},${ty}`).toBe(1)
    prev = { x: tx, y: ty }
  }
}

describe('findPath — basics', () => {
  it('walks a straight corridor end to end', () => {
    const level = blank()
    carve(level, 5, 5, 20, 5)
    const path = findPath(level, 5.5, 5.5, 20.5, 5.5)
    expect(path).not.toBeNull()
    expect(path!.length).toBe(15)
    assertWellFormed(level, path!, { x: 5.5, y: 5.5 })
    expect(path![path!.length - 1]).toEqual({ x: 20.5, y: 5.5 })
  })

  it('same tile → empty path (already there), even at different sub-tile positions', () => {
    const level = blank()
    carve(level, 5, 5, 6, 6)
    expect(findPath(level, 5.2, 5.2, 5.9, 5.9)).toEqual([])
  })

  it('routes around an L-wall instead of aiming through it', () => {
    const level = blank()
    carve(level, 4, 4, 20, 20)
    // A wall pocket: the straight line from (6,10) to (14,10) is blocked.
    for (let y = 6; y <= 14; y++) wall(level, 10, y)
    const path = findPath(level, 6.5, 10.5, 14.5, 10.5)
    expect(path).not.toBeNull()
    assertWellFormed(level, path!, { x: 6.5, y: 10.5 })
    // It detoured: longer than the blocked straight line's 8 steps.
    expect(path!.length).toBeGreaterThan(8)
  })

  it('threads a doorway maze (three walls, one gap each, alternating sides)', () => {
    const level = blank()
    carve(level, 2, 2, 30, 12)
    for (const [wx, gapY] of [
      [8, 3],
      [14, 11],
      [20, 3],
    ] as const) {
      for (let y = 2; y <= 12; y++) if (y !== gapY) wall(level, wx, y)
    }
    const path = findPath(level, 3.5, 7.5, 28.5, 7.5)
    expect(path).not.toBeNull()
    assertWellFormed(level, path!, { x: 3.5, y: 7.5 })
    // It passed through each gap (the only openings in each wall).
    for (const [wx, gapY] of [
      [8, 3],
      [14, 11],
      [20, 3],
    ] as const) {
      expect(path!.some((n) => Math.floor(n.x) === wx && Math.floor(n.y) === gapY)).toBe(true)
    }
  })
})

describe('findPath — doors', () => {
  it('passes through a closed unlocked door when it is the only way', () => {
    const level = blank()
    carve(level, 4, 4, 16, 8)
    for (let y = 4; y <= 8; y++) if (y !== 6) wall(level, 10, y)
    const closedDoors = new Set([key(level, 10, 6)])
    const path = findPath(level, 5.5, 6.5, 15.5, 6.5, { closedDoors })
    expect(path).not.toBeNull()
    expect(path!.some((n) => Math.floor(n.x) === 10 && Math.floor(n.y) === 6)).toBe(true)
  })

  it('prefers a modestly longer open route over shoving through a closed door', () => {
    const level = blank()
    carve(level, 4, 4, 16, 10)
    // Wall at x=10 with TWO gaps: a closed door on the straight line (y=6) and
    // an open gap a couple of tiles off (y=9). The detour costs 6 extra steps;
    // the door costs DOOR_COST (4)… so tune the detour under the penalty: use y=8
    // (4 extra steps < door cost 4+? equal-ish) — assert with a wider margin: y=7.
    for (let y = 4; y <= 10; y++) if (y !== 6 && y !== 7) wall(level, 10, y)
    const closedDoors = new Set([key(level, 10, 6)])
    const path = findPath(level, 5.5, 6.5, 15.5, 6.5, { closedDoors })
    expect(path).not.toBeNull()
    // The open gap at y=7 costs 2 extra steps; the door costs DOOR_COST (4) —
    // the router takes the open gap and never enters the door tile.
    expect(DOOR_COST).toBeGreaterThan(2)
    expect(path!.some((n) => Math.floor(n.x) === 10 && Math.floor(n.y) === 6)).toBe(false)
    expect(path!.some((n) => Math.floor(n.x) === 10 && Math.floor(n.y) === 7)).toBe(true)
  })

  it('treats a locked door as a wall (fails when it is the only way through)', () => {
    const level = blank()
    carve(level, 4, 4, 16, 8)
    for (let y = 4; y <= 8; y++) if (y !== 6) wall(level, 10, y)
    const lockedDoors = new Set([key(level, 10, 6)])
    expect(findPath(level, 5.5, 6.5, 15.5, 6.5, { lockedDoors })).toBeNull()
  })

  it('routes around a locked door when an open way exists', () => {
    const level = blank()
    carve(level, 4, 4, 16, 10)
    for (let y = 4; y <= 10; y++) if (y !== 6 && y !== 9) wall(level, 10, y)
    const lockedDoors = new Set([key(level, 10, 6)])
    const path = findPath(level, 5.5, 6.5, 15.5, 6.5, { lockedDoors })
    expect(path).not.toBeNull()
    expect(path!.some((n) => Math.floor(n.x) === 10 && Math.floor(n.y) === 6)).toBe(false)
    expect(path!.some((n) => Math.floor(n.x) === 10 && Math.floor(n.y) === 9)).toBe(true)
  })
})

describe('findPath — failure modes stay graceful and bounded', () => {
  it('unreachable target (sealed room) → null, not a hang or a bad path', () => {
    const level = blank()
    carve(level, 4, 4, 20, 20)
    // Seal an interior cell completely.
    carve(level, 30, 30, 32, 32)
    expect(findPath(level, 5.5, 5.5, 31.5, 31.5)).toBeNull()
  })

  it('a goal ON a wall → null immediately', () => {
    const level = blank()
    carve(level, 4, 4, 10, 10)
    expect(findPath(level, 5.5, 5.5, 2.5, 2.5)).toBeNull()
  })

  it('a start inside solid (degenerate) → null, no crash', () => {
    const level = blank()
    carve(level, 4, 4, 10, 10)
    expect(findPath(level, 1.5, 1.5, 5.5, 5.5)).toBeNull()
  })

  it('honors the node budget: a wide detour with a tiny cap fails cleanly', () => {
    const level = blank()
    carve(level, 2, 2, 30, 30)
    // Force a detour so the search must expand widely, then strangle the budget.
    for (let y = 2; y <= 28; y++) wall(level, 16, y)
    expect(findPath(level, 5.5, 15.5, 28.5, 15.5, { maxNodes: 20 })).toBeNull()
    // The same query with the default budget succeeds — the cap was the limit.
    expect(findPath(level, 5.5, 15.5, 28.5, 15.5)).not.toBeNull()
  })

  it('out-of-bounds goal → null', () => {
    const level = blank()
    carve(level, 4, 4, 10, 10)
    expect(findPath(level, 5.5, 5.5, -3.5, 5.5)).toBeNull()
    expect(findPath(level, 5.5, 5.5, 5.5, 10_000.5)).toBeNull()
  })
})

describe('findPath — best effort (guard the approach)', () => {
  it('an unreachable goal yields the route to the nearest reachable tile', () => {
    const level = blank()
    carve(level, 4, 4, 20, 20)
    // Sealed 3×3 pocket inside the field, goal at its centre.
    for (let x = 10; x <= 14; x++) {
      wall(level, x, 10)
      wall(level, x, 14)
    }
    for (let y = 10; y <= 14; y++) {
      wall(level, 10, y)
      wall(level, 14, y)
    }
    expect(findPath(level, 5.5, 5.5, 12.5, 12.5)).toBeNull() // strict: no route
    const near = findPath(level, 5.5, 5.5, 12.5, 12.5, { bestEffort: true })
    expect(near).not.toBeNull()
    assertWellFormed(level, near!, { x: 5.5, y: 5.5 })
    const end = near![near!.length - 1]
    // Ends pressed against the pocket (adjacent ring), NOT on the goal tile.
    expect(Math.abs(end.x - 12.5) + Math.abs(end.y - 12.5)).toBeLessThanOrEqual(3)
    expect(Math.floor(end.x) === 12 && Math.floor(end.y) === 12).toBe(false)
  })

  it('goal already as close as possible → null (standing still is the answer)', () => {
    const level = blank()
    carve(level, 4, 4, 8, 8)
    // Goal far outside the tiny carved pocket; start already at its nearest edge.
    const r = findPath(level, 8.5, 6.5, 30.5, 6.5, { bestEffort: true })
    expect(r).toBeNull()
  })

  it('best-effort is deterministic across calls', () => {
    const level = blank()
    carve(level, 4, 4, 20, 20)
    for (let x = 10; x <= 14; x++) {
      wall(level, x, 10)
      wall(level, x, 14)
    }
    for (let y = 10; y <= 14; y++) {
      wall(level, 10, y)
      wall(level, 14, y)
    }
    const a = findPath(level, 5.5, 5.5, 12.5, 12.5, { bestEffort: true })
    const b = findPath(level, 5.5, 5.5, 12.5, 12.5, { bestEffort: true })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('findPath — determinism', () => {
  it('identical queries return identical arrays (twice, and across level rebuilds)', () => {
    const build = (): Level => {
      const level = blank()
      carve(level, 4, 4, 30, 30)
      for (let y = 8; y <= 26; y++) wall(level, 17, y)
      for (let x = 8; x <= 17; x++) wall(level, x, 12)
      return level
    }
    const a = findPath(build(), 6.5, 20.5, 28.5, 10.5)
    const b = findPath(build(), 6.5, 20.5, 28.5, 10.5)
    expect(a).not.toBeNull()
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('ties break by the fixed neighbour order, not by luck: an open field yields a stable path', () => {
    const level = blank()
    carve(level, 4, 4, 30, 30)
    // Many equal-cost routes exist across an open field; the answer must be ONE
    // canonical path, byte-stable across calls.
    const runs = Array.from({ length: 3 }, () => findPath(level, 5.5, 5.5, 25.5, 25.5))
    for (const r of runs) {
      expect(r).not.toBeNull()
      expect(JSON.stringify(r)).toBe(JSON.stringify(runs[0]))
      assertWellFormed(level, r!, { x: 5.5, y: 5.5 })
      expect(r!.length).toBe(40) // Manhattan-optimal: no wasted steps
    }
  })
})
