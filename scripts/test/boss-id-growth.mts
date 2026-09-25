/** How fast does w.nextId climb during an ACTIVE boss fight (brood churn)?
 *  The wire entity id is a u16 (encodeSnapshot: w.u16(e.id)), ceiling 65535. */
import { createWorld, tickWorld } from '../../src/game/world'
import { populateWorld } from '../../src/game/populate'
import { setupFloor } from '../../src/game/systems/missions'
import { spawnPlayer } from '../../src/game/player'
import { emptyInput } from '../../src/game/types'

for (const seed of [1, 99, 20260808]) {
  const w = createWorld(seed, 1, 'normal')
  populateWorld(w); setupFloor(w)
  for (let s = 0; s < 4; s++) spawnPlayer(w, s, w.level.spawn.x, w.level.spawn.y)
  const boss = w.mission.targetEntityId !== undefined ? w.byId.get(w.mission.targetEntityId) : undefined
  if (!boss || boss.archetype !== 'boss') { console.log(`seed ${seed}: no boss (${w.mission.template})`); continue }
  for (const e of w.entities) if (e.playerCtl) { e.pos.x = boss.pos.x + 2; e.pos.y = boss.pos.y; if (e.health) { e.health.hp = 1e6; e.health.max = 1e6 } }
  // Keep the boss alive in phase 1 so it summons for the whole sample.
  const inputs = new Map(Array.from({ length: 4 }, (_, s) => [s, { ...emptyInput(), attack: true }]))
  const start = w.nextId
  const TICKS = 30 * 60 * 3 // 3 minutes of boss fight
  for (let t = 0; t < TICKS; t++) {
    if (boss.health) boss.health.hp = boss.health.max // pin phase 1 (max summoning)
    tickWorld(w, inputs)
  }
  const perMin = (w.nextId - start) / 3
  console.log(`seed ${seed}: nextId ${start} -> ${w.nextId} over 3 min of boss fight = ${perMin.toFixed(0)} ids/min`)
  console.log(`   time to reach the u16 wire ceiling (65536): ${(65536 / perMin / 60).toFixed(1)} hours of continuous boss fighting`)
}
