/** Host sim tick cost around the boss release. 33.3ms is the 30Hz budget. */
import { createWorld, tickWorld } from '../../src/game/world'
import { populateWorld } from '../../src/game/populate'
import { setupFloor, nextFloor } from '../../src/game/systems/missions'
import { spawnPlayer } from '../../src/game/player'
import { emptyInput } from '../../src/game/types'

const PLAYERS = 4
const build = (seed: number, floor: number) => {
  const w = createWorld(seed, 1, 'normal')
  populateWorld(w); setupFloor(w)
  for (let s = 0; s < PLAYERS; s++) spawnPlayer(w, s, w.level.spawn.x, w.level.spawn.y)
  while (w.floor < floor) nextFloor(w)
  return w
}
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return `mean=${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)}ms p50=${s[Math.floor(s.length * 0.5)].toFixed(2)} p95=${s[Math.floor(s.length * 0.95)].toFixed(2)} max=${s[s.length - 1].toFixed(2)}`
}
for (const [seed, floor] of [[20260808, 1], [1234, 2], [42, 3], [99, 1]] as [number, number][]) {
  const w = build(seed, floor)
  if (w.mission.template !== 'assassinate' && w.mission.template !== 'infiltrate') continue
  const gate = w.mission.objectiveDoorId !== undefined ? w.byId.get(w.mission.objectiveDoorId) : undefined
  const boss = w.mission.targetEntityId !== undefined ? w.byId.get(w.mission.targetEntityId) : undefined
  if (!gate?.door || !boss) continue
  for (const e of w.entities) {
    if (!e.playerCtl) continue
    e.pos.x = boss.pos.x + 1.5; e.pos.y = boss.pos.y
    if (e.health) { e.health.hp = 1e6; e.health.max = 1e6 }
  }
  const inputs = new Map(Array.from({ length: PLAYERS }, (_, s) => [s, { ...emptyInput() }]))
  const run = (n: number) => { const out: number[] = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); tickWorld(w, inputs); out.push(performance.now() - t0) } return out }
  run(60) // warm
  const before = run(300)
  gate.door.locked = false; gate.door.open = true
  const after = run(600)
  console.log(`seed ${seed} f${floor} entities=${w.entities.length}`)
  console.log(`   before: ${stats(before)}`)
  console.log(`   after : ${stats(after)}`)
}
