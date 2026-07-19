// Sweep seeds: how often does an idle player at spawn get downed within 10s?
import { createWorld, tickWorld } from '../../src/game/world'
import { populateWorld } from '../../src/game/populate'
import { setupFloor } from '../../src/game/systems/missions'
import { spawnPlayer } from '../../src/game/player'
import type { InputCmd } from '../../src/game/types'

const idle: InputCmd = { seq: 0, moveX: 0, moveY: 0, aimX: 1, aimY: 0, attack: false, interact: false, special: false, hotbar: -1, throwItem: false, roll: false }

let downs = 0, hurts = 0
const downedSeeds: number[] = []
for (let seed = 1; seed <= 100; seed++) {
  const w = createWorld(seed, 1, 'normal')
  populateWorld(w)
  setupFloor(w)
  const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
  const inputs = new Map<number, InputCmd>([[0, idle]])
  let downedAt = -1
  for (let t = 0; t < 300; t++) {
    tickWorld(w, inputs)
    if (p.playerCtl?.downed) { downedAt = t; break }
  }
  if (downedAt >= 0) { downs++; downedSeeds.push(seed) }
  else if (p.health!.hp < p.health!.max) hurts++
}
console.log(`Downed within 10s idle: ${downs}/100 seeds -> [${downedSeeds.join(', ')}]`)
console.log(`Hurt but alive: ${hurts}/100`)
