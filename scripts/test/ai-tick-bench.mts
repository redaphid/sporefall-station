// Sim cost of goal commitment and activities: ms per tick on populated
// generated floors, AI flags off (main's AI) versus on.
//   npx tsx scripts/test/ai-tick-bench.mts
import { spawnPlayer } from '../../src/game/player'
import { populateWorld } from '../../src/game/populate'
import { playerSpawnPoint } from '../../src/game/spawnPlacement'
import { setupFloor } from '../../src/game/systems/missions'
import { emptyInput } from '../../src/game/types'
import { createWorld, tickWorld, type World } from '../../src/game/world'

const TICKS = 1800
const run = (seed: number, floor: number, flags: World['aiFlags']): number => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  const at = playerSpawnPoint(w.level, 0)
  spawnPlayer(w, 0, at.x, at.y)
  w.aiFlags = flags
  const t0 = performance.now()
  for (let i = 0; i < TICKS; i++) tickWorld(w, new Map([[0, emptyInput()]]))
  return (performance.now() - t0) / TICKS
}

for (const [seed, floor] of [
  [11, 1],
  [47, 1],
  [23, 3],
  [5, 3],
]) {
  run(seed, floor, {}) // warm up
  const off = run(seed, floor, { commitment: false, activities: false })
  const on = run(seed, floor, {})
  console.log(`seed ${seed} floor ${floor}: off ${off.toFixed(3)} ms/tick, on ${on.toFixed(3)} ms/tick (${(((on - off) / off) * 100).toFixed(1)}%)`)
}
