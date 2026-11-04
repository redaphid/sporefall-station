// Dump the think-by-think record of the NPCs that flip goals most on a
// generated floor: goal, mode, hp, scores, and where it stands.
//   npx tsx scripts/test/goal-flip-probe.mts <seed> <floor> [ticks]
import { spawnPlayer } from '../../src/game/player'
import { populateWorld } from '../../src/game/populate'
import { playerSpawnPoint } from '../../src/game/spawnPlacement'
import { setupFloor } from '../../src/game/systems/missions'
import { emptyInput } from '../../src/game/types'
import { createWorld, tickWorld } from '../../src/game/world'

const [seed, floor, ticks] = process.argv.slice(2).map(Number)
const w = createWorld(seed, floor)
populateWorld(w)
setupFloor(w)
const at = playerSpawnPoint(w.level, 0)
spawnPlayer(w, 0, at.x, at.y)
const flips = new Map<number, number>()
const prev = new Map<number, string>()
const log = new Map<number, string[]>()
for (let i = 0; i < (ticks || 2700); i++) {
  tickWorld(w, new Map([[0, emptyInput()]]))
  for (const e of w.entities) {
    if (!e.ai || e.dead) continue
    const g = e.ai.goal ?? 'none'
    const p = prev.get(e.id)
    if (p !== undefined && p !== g) {
      flips.set(e.id, (flips.get(e.id) ?? 0) + 1)
      const l = log.get(e.id) ?? []
      if (l.length < 14)
        l.push(
          `t${w.tick} ${p}->${g} mode=${e.ai.mode} hp=${e.health?.hp}/${e.health?.max} pos=${e.pos.x.toFixed(1)},${e.pos.y.toFixed(1)} tgt=${e.ai.targetId} fleeFrom=${JSON.stringify(e.ai.fleeFrom)} scores=${JSON.stringify(e.ai.lastScores)}`,
        )
      log.set(e.id, l)
    }
    prev.set(e.id, g)
  }
}
const worst = [...flips].sort((a, b) => b[1] - a[1]).slice(0, 4)
for (const [id, n] of worst) {
  const e = w.byId.get(id)!
  console.log(`\n#${id} ${e.archetype} faction=${e.ai!.faction} behavior=${e.ai!.behavior} flips=${n} zone=${JSON.stringify(e.ai!.zone)}`)
  for (const l of log.get(id)!) console.log('  ' + l)
}
