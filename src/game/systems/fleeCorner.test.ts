// Regression: "the ai will often run into corners forever, especially when
// scared." A body that panics into a concave corner or a dead end used to stay
// in `flee` FOREVER — it kept walking (21 tiles of path across 200 ticks) while
// getting nowhere (0.5 tiles of net displacement), because:
//
//   1. `openFleeDir` probed ONE point at `pos + dir * FLEE_PROBE`. On a diagonal
//      that is 0.7071 * 1.2 = 0.849 tiles — less than one tile — so from the
//      first ~15% of a tile the probe landed back in the body's OWN tile, read
//      it as open, and offered a wall as an escape route.
//   2. Nothing anywhere caught it. The `aggro` branch has had stall detection
//      since the cold-trail work; the `flee` branch had none at all, so a body
//      that made zero headway simply kept re-choosing the same blocked heading.
//
// These set exact geometry, run the REAL tickWorld with real arbitration (the
// panic is genuine — a badly wounded civilian in a hostile world — never forced
// per-tick, since forcing `mode` every tick would mask the very stall guard
// under test), and assert on the outcome.

import { describe, expect, it } from 'vitest'
import { Tile } from '../levelgen/level'
import { spawnNpc } from '../populate'
import { emptyInput } from '../types'
import { createWorld, tickWorld, type World } from '../world'

const TICKS = 200

const carve = (w: World, x0: number, y0: number, x1: number, y1: number): void => {
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      w.level.tiles[y * w.level.w + x] = Tile.Floor
      w.level.solid[y * w.level.w + x] = 0
    }
}

const wall = (w: World, x0: number, y0: number, x1: number, y1: number): void => {
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      w.level.tiles[y * w.level.w + x] = Tile.Wall
      w.level.solid[y * w.level.w + x] = 1
    }
}

interface Run {
  net: number
  path: number
  modes: Set<string>
  longestStill: number
}

/** Build a sealed arena, drop a panicking civilian and a static menace in it,
 * and run the real sim. Bodies spawn at tile CENTRES: radius is 0.35, so a body
 * placed on a tile CORNER overlaps its neighbours and collision pins it — which
 * mimics this very bug and is not it. */
const runScenario = (
  build: (w: World, cx: number, cy: number) => [number, number, number, number],
): Run => {
  const w = createWorld(1, 1, 'normal', true) // hostile: the fear is real
  const cx = Math.floor(w.level.w / 2)
  const cy = Math.floor(w.level.h / 2)
  wall(w, 0, 0, w.level.w - 1, w.level.h - 1)
  const [nx, ny, tx, ty] = build(w, cx, cy)

  const npc = spawnNpc(w, 'civilian', nx + 0.5, ny + 0.5)
  npc.health = { hp: 1, max: 1e6, iframes: 1e9 } // badly wounded ⇒ flees, and survives the window
  npc.ai!.sightRange = 12
  const threat = spawnNpc(w, 'thug', tx + 0.5, ty + 0.5)
  threat.health = { hp: 1e6, max: 1e6, iframes: 1e9 }
  threat.ai = undefined // static menace: isolate flight from pursuit

  npc.ai!.mode = 'flee'
  npc.ai!.targetId = threat.id

  const start = { x: npc.pos.x, y: npc.pos.y }
  const input = new Map([[0, emptyInput()]])
  const modes = new Set<string>()
  let prev = { x: npc.pos.x, y: npc.pos.y }
  let path = 0
  let still = 0
  let longestStill = 0

  for (let t = 0; t < TICKS; t++) {
    tickWorld(w, input)
    const step = Math.hypot(npc.pos.x - prev.x, npc.pos.y - prev.y)
    path += step
    if (step < 0.01) longestStill = Math.max(longestStill, ++still)
    else still = 0
    modes.add(String(npc.ai!.mode))
    prev = { x: npc.pos.x, y: npc.pos.y }
  }
  return { net: Math.hypot(npc.pos.x - start.x, npc.pos.y - start.y), path, modes, longestStill }
}

/** Threat to the south-west, walls north and east: the away-vector points
 * straight into the corner. */
const concaveCorner = (w: World, cx: number, cy: number): [number, number, number, number] => {
  carve(w, cx - 12, cy - 12, cx + 12, cy + 12)
  wall(w, cx + 1, cy - 12, cx + 1, cy + 12)
  wall(w, cx - 12, cy + 1, cx + 12, cy + 1)
  return [cx, cy, cx - 3, cy - 3]
}

/** A one-tile-wide dead end, fled INTO; the only way out is back past the threat. */
const deadEnd = (w: World, cx: number, cy: number): [number, number, number, number] => {
  carve(w, cx - 12, cy - 2, cx + 12, cy + 2)
  wall(w, cx - 12, cy + 1, cx + 12, cy + 1)
  wall(w, cx - 12, cy - 1, cx + 12, cy - 1)
  wall(w, cx + 4, cy - 2, cx + 4, cy + 2)
  return [cx + 3, cy, cx - 2, cy]
}

describe('fleeing bodies do not grind in corners forever', () => {
  it('gives up fleeing when a concave corner offers no way out', () => {
    const r = runScenario(concaveCorner)
    // THE regression: it must not still be running at the wall 200 ticks later.
    expect(r.modes.has('flee')).toBe(true) // it did panic…
    expect([...r.modes].some((m) => m !== 'flee')).toBe(true) // …and then stopped
    // Before the fix: 21.3 tiles walked for 0.50 net. The tell is a long walk
    // that goes nowhere, so bound the wasted travel rather than only the net.
    expect(r.path).toBeLessThan(15)
  })

  it('gives up fleeing at the end of a dead-end alcove', () => {
    const r = runScenario(deadEnd)
    expect([...r.modes].some((m) => m !== 'flee')).toBe(true)
    expect(r.path).toBeLessThan(15) // was 21.3 for 0.64 net
  })

  it('still runs freely when there IS somewhere to go', () => {
    // The control: none of the above may cost a body its ability to actually
    // flee across open ground.
    const r = runScenario((w, cx, cy) => {
      carve(w, cx - 12, cy - 12, cx + 12, cy + 12)
      return [cx, cy, cx - 3, cy]
    })
    expect(r.net).toBeGreaterThan(10)
    expect(r.longestStill).toBe(0) // never once stalls in the open
    expect([...r.modes]).toEqual(['flee']) // and never gives up while escape works
  })
})
