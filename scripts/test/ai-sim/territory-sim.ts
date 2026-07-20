// #77 territory regression evidence. Boots real floors (populate → mission
// setup), lets the crew settle, and measures the two headline metrics: what
// fraction of zoned NPCs pursue a building-derived goal (work/garrison), and how
// hard the objective wing's garrison converges on its core — while residents of
// OTHER wings hold their own turf. Deterministic per seed.
//
//   npx tsx scripts/test/ai-sim/territory-sim.ts

import { rectCenter } from '../../../src/game/levelgen/level'
import { populateWorld } from '../../../src/game/populate'
import { setupFloor } from '../../../src/game/systems/missions'
import { emptyInput } from '../../../src/game/types'
import { createWorld, tickWorld, type World } from '../../../src/game/world'

const meanTo = (list: { pos: { x: number; y: number } }[], cx: number, cy: number): number =>
  list.reduce((s, e) => s + Math.hypot(e.pos.x - cx, e.pos.y - cy), 0) / Math.max(1, list.length)

const run = (seed: number, floor: number): void => {
  const w: World = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  const tb = w.mission.targetBuilding
  if (tb === undefined || tb < 0) {
    console.log(`seed=${seed} f=${floor}: no objective building`)
    return
  }
  const b = w.level.buildings[tb]
  const core = rectCenter(b.objectiveRoom ?? b.rect)
  const zoned = () => w.entities.filter((e) => e.ai?.zone && !e.dead)
  const obj = () => zoned().filter((e) => e.ai!.zone!.building === tb)
  const other = () => zoned().filter((e) => e.ai!.zone!.building !== tb)

  const objBefore = meanTo(obj(), core.x, core.y)
  const otherBefore = meanTo(other(), core.x, core.y)
  const input = new Map([[0, emptyInput()]])
  for (let t = 0; t < 150; t++) tickWorld(w, input)
  const objAfter = meanTo(obj(), core.x, core.y)
  const otherAfter = meanTo(other(), core.x, core.y)

  const z = zoned()
  const derived = z.filter((e) => e.ai!.goal === 'work' || e.ai!.goal === 'garrison').length
  console.log(
    `seed=${String(seed).padStart(2)} f=${floor} ${b.role.padEnd(9)}` +
      `  garrison→core ${objBefore.toFixed(1)}→${objAfter.toFixed(1)}` +
      `  other-wings→core ${otherBefore.toFixed(1)}→${otherAfter.toFixed(1)} (held)` +
      `  building-derived goals ${((100 * derived) / z.length).toFixed(0)}% of ${z.length}`,
  )
}

console.log('═══ #77 NPC purpose & building territory ═══')
for (const [s, f] of [
  [2, 1],
  [9, 1],
  [15, 1],
  [16, 1],
  [3, 1],
] as [number, number][])
  run(s, f)
