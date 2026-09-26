/**
 * Which creatures stand in floor fire during the extraction test's idle boot
 * (seed:floor keys on the command line, 30 idle ticks each, as
 * gen-mission-baseline.mts builds them)? Explains a moved baseline hash.
 *
 * Run: npx tsx scripts/test/idle-fire-census.mts 6:8 16:3
 */
import { populateWorld } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { fireAt } from '../../src/game/systems/fire'
import { setupFloor } from '../../src/game/systems/missions'
import { emptyInput } from '../../src/game/types'
import { createWorld, tickWorld } from '../../src/game/world'

for (const key of process.argv.slice(2)) {
  const [seed, floor] = key.split(':').map(Number)
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
  const fires = w.entities.filter((e) => e.fire && !e.dead).map((e) => `${Math.floor(e.pos.x)},${Math.floor(e.pos.y)}`)
  const lit = new Map<number, string>()
  let firstFire: number | undefined
  for (let t = 0; t < 30; t++) {
    tickWorld(w, new Map([[0, emptyInput()]]))
    if (firstFire === undefined && w.entities.some((e) => e.fire && !e.dead)) firstFire = w.tick
    for (const e of w.entities) {
      if (!(e.ai || e.playerCtl) || !e.fx?.burning || lit.has(e.id)) continue
      const inFire = fireAt(w, Math.floor(e.pos.x), Math.floor(e.pos.y))
      lit.set(e.id, `${e.archetype}#${e.id} lit@${w.tick} ${inFire ? 'standing in fire' : `by status (source ${e.fx.burning.source ?? 'none'})`}`)
    }
  }
  console.log(`${key}: fires at boot [${fires.join(' ')}], first fire @${firstFire ?? 'never'}, creatures lit in 30 ticks: ${[...lit.values()].join('; ') || 'none'}`)
}
