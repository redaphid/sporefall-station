/** Does letting the boss out actually WIPE a 4-player party (-> game over ->
 *  the host presses "play again")? That restart is the freeze trigger. */
import { createWorld, tickWorld } from '../../src/game/world'
import { populateWorld } from '../../src/game/populate'
import { setupFloor } from '../../src/game/systems/missions'
import { spawnPlayer } from '../../src/game/player'
import { emptyInput } from '../../src/game/types'

let wipes = 0, runs = 0
const times: number[] = []
for (let seed = 1; seed <= 40; seed++) {
  const w = createWorld(seed, 1, 'normal')
  populateWorld(w); setupFloor(w)
  for (let s = 0; s < 4; s++) spawnPlayer(w, s, w.level.spawn.x, w.level.spawn.y)
  const boss = w.mission.targetEntityId !== undefined ? w.byId.get(w.mission.targetEntityId) : undefined
  if (!boss || boss.archetype !== 'boss') continue
  runs++
  // "We let the boss out": the party walks into the boss room. Players do not
  // fight back (a real party does, but this bounds the danger).
  for (const e of w.entities) if (e.playerCtl) { e.pos.x = boss.pos.x + 2; e.pos.y = boss.pos.y }
  const inputs = new Map(Array.from({ length: 4 }, (_, s) => [s, { ...emptyInput() }]))
  let wipedAt = -1
  for (let t = 0; t < 30 * 120; t++) {
    tickWorld(w, inputs)
    if (w.gameOver) { wipedAt = t; break }
  }
  if (wipedAt >= 0) { wipes++; times.push(wipedAt / 30) }
}
times.sort((a, b) => a - b)
console.log(`boss floors tested: ${runs}`)
console.log(`party WIPED (gameOver, host must restart): ${wipes}/${runs} (${((wipes / runs) * 100).toFixed(0)}%)`)
if (times.length) console.log(`time to wipe: median ${times[Math.floor(times.length / 2)].toFixed(0)}s, fastest ${times[0].toFixed(0)}s`)
