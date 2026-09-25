/** Sanity: does resolving the spawn intent push brood further from the boss? */
import { createWorld, tickWorld } from '../../src/game/world'
import { populateWorld } from '../../src/game/populate'
import { setupFloor } from '../../src/game/systems/missions'
import { spawnPlayer } from '../../src/game/player'
import { emptyInput } from '../../src/game/types'

const d: number[] = []
for (const seed of [1, 3, 6, 9, 11, 99]) {
  const w = createWorld(seed, 1, 'normal')
  populateWorld(w); setupFloor(w)
  for (let s = 0; s < 4; s++) spawnPlayer(w, s, w.level.spawn.x, w.level.spawn.y)
  const boss = w.mission.targetEntityId !== undefined ? w.byId.get(w.mission.targetEntityId) : undefined
  if (!boss || boss.archetype !== 'boss') continue
  for (const e of w.entities) if (e.playerCtl) { e.pos.x = boss.pos.x + 2; e.pos.y = boss.pos.y; if (e.health) { e.health.hp = 1e6; e.health.max = 1e6 } }
  const inputs = new Map(Array.from({ length: 4 }, (_, s) => [s, { ...emptyInput() }]))
  const known = new Set(w.entities.map((e) => e.id))
  for (let t = 0; t < 900; t++) {
    tickWorld(w, inputs)
    for (const e of w.entities) {
      if (known.has(e.id) || e.archetype !== 'sporeling') continue
      known.add(e.id)
      d.push(Math.hypot(e.pos.x - boss.pos.x, e.pos.y - boss.pos.y))
    }
  }
}
d.sort((a, b) => a - b)
const mean = d.reduce((a, b) => a + b, 0) / d.length
console.log(`brood spawn distance from boss (n=${d.length}): mean=${mean.toFixed(2)} p50=${d[Math.floor(d.length*0.5)].toFixed(2)} p95=${d[Math.floor(d.length*0.95)].toFixed(2)} max=${d[d.length-1].toFixed(2)}`)
console.log(`  beyond BROOD_RADIUS (6): ${d.filter((x) => x > 6).length} (${((d.filter((x) => x > 6).length / d.length) * 100).toFixed(1)}%)`)
