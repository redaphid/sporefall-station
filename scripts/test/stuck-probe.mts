/** Is a player spawned inside a wall actually STUCK? Drive real ticks. */
import { createWorld, tickWorld } from '../../src/game/world'
import { populateWorld } from '../../src/game/populate'
import { setupFloor, nextFloor } from '../../src/game/systems/missions'
import { spawnPlayer } from '../../src/game/player'
import { isSolidTile } from '../../src/game/levelgen/level'
import { emptyInput } from '../../src/game/types'

const build = (seed: number, floor: number) => {
  const w = createWorld(seed, 1, 'normal')
  populateWorld(w); setupFloor(w)
  const host = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
  while (w.floor < floor) nextFloor(w)
  return { w, host }
}

// seed 1, floor 2, slot 3 -> spawn.x + 1.8 is solid (from spawn-wall-probe)
const { w } = build(1, 2)
const sx = w.level.spawn.x, sy = w.level.spawn.y
console.log(`floor ${w.floor} spawn=(${sx},${sy})`)
for (const slot of [1, 2, 3, 4]) {
  const x = sx + slot * 0.6
  const p = spawnPlayer(w, slot, x, sy)
  const solid = isSolidTile(w.level, Math.floor(x), Math.floor(sy))
  const start = { x: p.pos.x, y: p.pos.y }
  // Try to walk out in 8 directions, 40 ticks each.
  const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]
  let moved = 0
  for (const [dx, dy] of dirs) {
    const inputs = new Map([[slot, { ...emptyInput(), moveX: dx, moveY: dy }]])
    for (let t = 0; t < 40; t++) tickWorld(w, inputs)
    moved = Math.max(moved, Math.hypot(p.pos.x - start.x, p.pos.y - start.y))
  }
  console.log(`slot ${slot}: x=${x.toFixed(2)} solidTile=${solid} movedAfter320ticks=${moved.toFixed(3)} finalPos=(${p.pos.x.toFixed(2)},${p.pos.y.toFixed(2)})`)
}
