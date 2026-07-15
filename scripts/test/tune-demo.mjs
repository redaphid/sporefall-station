import { HostSession } from '../../src/app/hostSession.ts'
import { applyScenario } from '../../src/game/scenarios.ts'
import { createScriptedInput, SCRIPTS, scriptTicks } from '../../src/input/scripted.ts'

// usage: tsx tune-demo.mjs <scenario=demo> <script=demo> <class=soldier> [from] [to]
const scenario = process.argv[2] ?? 'demo'
const scriptName = process.argv[3] ?? scenario
const cls = process.argv[4] ?? 'soldier'
const from = Number(process.argv[5] ?? 0)
const to = Number(process.argv[6] ?? 0)

const steps = SCRIPTS[scriptName]
const s = (() => { const s = new HostSession(7, cls, createScriptedInput(steps)); applyScenario(s.world, scenario); return s })()
const total = scriptTicks(steps)

const state = () => {
  const w = s.world
  const pl = w.entities.find((e) => e.playerCtl)
  const enemies = w.entities.filter((e) => e.ai && e.ai.faction !== 'civ' && !e.dead).map((e) => `${e.archetype}@${e.pos.x.toFixed(1)},${e.pos.y.toFixed(1)}:${e.health.hp}`)
  const doors = w.entities.filter((e) => e.door).map((e) => `${e.pos.x.toFixed(0)},${e.pos.y.toFixed(0)}:${e.door.locked ? 'L' : e.door.open ? 'open' : 'shut'}`)
  return { t: w.tick, px: +pl.pos.x.toFixed(1), py: +pl.pos.y.toFixed(1), hp: pl.health.hp, mission: w.mission.complete, go: w.gameOver, enemies, doors }
}

for (let t = 0; t <= total + 30; t++) {
  if (from && t >= from && t <= to && t % 4 === 0) console.log(JSON.stringify(state()))
  s.tick()
}
console.log('FINAL', JSON.stringify(state()))
