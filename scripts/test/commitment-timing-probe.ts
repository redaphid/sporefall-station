// Does attack commitment delay the first hit by EXACTLY the designed wind-up,
// or by more? That is the difference between "three tests encode the old
// instant-attack timing" (widen the budgets) and "something else got slower"
// (a real regression, leave them failing).
//
// Reproduces the exact scenario from predator.test.ts's integration smoke test
// and reports the tick at which the victim FIRST loses hp. Run this file on
// `main` and on `feat/commitment` and compare.
//
// Run: npx tsx scripts/test/commitment-timing-probe.ts

import { spawnNpc } from '../../src/game/populate'
import { emptyInput } from '../../src/game/types'
import { createWorld, tickWorld } from '../../src/game/world'
import { Tile } from '../../src/game/levelgen/level'
import { attackPhase } from '../../src/game/systems/commitment'

const TICKS = 200

const arena = () => {
  const w = createWorld(1, 1, 'normal', false)
  const cx = Math.floor(w.level.w / 2)
  const cy = Math.floor(w.level.h / 2)
  for (let y = cy - 8; y <= cy + 8; y++)
    for (let x = cx - 8; x <= cx + 8; x++) {
      w.level.tiles[y * w.level.w + x] = Tile.Floor
      w.level.solid[y * w.level.w + x] = 0
    }
  return { w, cx, cy }
}

const wound = (e: ReturnType<typeof spawnNpc>, frac: number): void => {
  e.health!.hp = Math.round(e.health!.max * frac)
}

const { w, cx, cy } = arena()
const stalker = spawnNpc(w, 'stalker', cx, cy)
stalker.ai!.sightRange = 14
const weak = spawnNpc(w, 'gangster', cx + 4, cy)
wound(weak, 0.15)

const startHp = weak.health!.hp
let firstDamageTick = -1
let firstContactTick = -1
const hits: number[] = []
let prevHp = startHp
const input = new Map([[0, emptyInput()]])

for (let t = 0; t < TICKS; t++) {
  tickWorld(w, input)
  const d = Math.hypot(weak.pos.x - stalker.pos.x, weak.pos.y - stalker.pos.y)
  if (firstContactTick < 0 && d <= 1.1 + weak.radius) firstContactTick = t
  const hp = weak.health!.hp
  if (hp < prevHp) {
    if (firstDamageTick < 0) firstDamageTick = t
    hits.push(t)
    prevHp = hp
  }
  if (process.env.TRACE && t >= 24 && t <= 60) {
    const a = stalker.attack
    console.log(
      `  t${t} mode=${stalker.ai!.mode} dist=${d.toFixed(2)} phase=${attackPhase(stalker, w.tick)}` +
        (a ? ` startAt=${a.startAt} activeAt=${a.activeAt} endAt=${a.endAt}` : ' attack=none') +
        ` cd=${stalker.combat?.cooldown ?? -1}`,
    )
  }
  if (weak.dead) break
}

console.log(`victim start hp        ${startHp} (threshold for the test: < ${startHp})`)
console.log(`first in melee range   tick ${firstContactTick}`)
console.log(`FIRST DAMAGE           tick ${firstDamageTick}`)
console.log(`  -> delay from contact to first damage: ${firstDamageTick - firstContactTick} ticks`)
console.log(`hits in first 30 ticks ${hits.filter((h) => h < 30).length}   (predator.test.ts asserts >= 1)`)
console.log(`all hit ticks          [${hits.slice(0, 10).join(', ')}${hits.length > 10 ? ', …' : ''}]`)
if (hits.length > 1) {
  const gaps = hits.slice(1).map((h, i) => h - hits[i])
  console.log(`inter-hit gaps         [${gaps.slice(0, 8).join(', ')}]`)
}
