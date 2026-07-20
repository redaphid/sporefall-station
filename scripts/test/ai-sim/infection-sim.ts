// Spore-contagion simulation. A packed crew room, a single spore bloom at its
// centre. Baseline: the spore is a pure DOT — nobody's behaviour changes, the
// crowd wanders off. Proto (infection flag): exposed crew TURN and hunt the
// clean, spreading spore on contact — an emergent outbreak the baseline engine
// cannot produce at all. Measures the epidemic curve + R0-style spread.
//
//   npx tsx scripts/test/ai-sim/infection-sim.ts

import { addNpc, center, makeArena } from './arena'
import { spawnSporeBurst } from '../../../src/game/systems/spore'
import { tickWorld, type World } from '../../../src/game/world'
import { emptyInput } from '../../../src/game/types'

const buildOutbreak = (seed: number): World => {
  const w = makeArena(seed, 18, false) // peaceful world — hostility must come from infection alone
  const c = center(w)
  // 24 crew packed in a 6x4 grid around the bloom point.
  let n = 0
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 6; gx++) {
      addNpc(w, 'civilian', c.x - 5 + gx * 2, c.y - 3 + gy * 2, { behavior: 'skittish', sight: 8 })
      n++
    }
  }
  return w
}

const infectedCount = (w: World): number => w.entities.filter((e) => e.infected && !e.dead).length
const crewCount = (w: World): number => w.entities.filter((e) => e.ai && !e.dead).length

const runOutbreak = (label: string, proto: boolean): void => {
  const w = buildOutbreak(7)
  if (proto) w.proto = { infection: true }
  const c = center(w)
  const start = crewCount(w)
  spawnSporeBurst(w, Math.floor(c.x), Math.floor(c.y)) // patient-zero cloud
  const input = new Map([[0, emptyInput()]])
  const curve: number[] = []
  let firstTurnTick = -1
  let halfTick = -1
  for (let t = 0; t < 900; t++) {
    tickWorld(w, input)
    const inf = infectedCount(w)
    if (inf > 0 && firstTurnTick < 0) firstTurnTick = t
    if (halfTick < 0 && inf >= start / 2) halfTick = t
    if (t % 90 === 89) curve.push(inf)
  }
  const finalInf = infectedCount(w)
  console.log(`\n### ${label}`)
  console.log(`  crew=${start}  final infected=${finalInf}  survivors(clean)=${crewCount(w) - finalInf}`)
  console.log(`  first turn @tick ${firstTurnTick}  half-infected @tick ${halfTick}`)
  console.log(`  infected curve (every 3s): ${curve.join(' → ')}`)
}

runOutbreak('BASELINE (spore = DOT only)', false)
runOutbreak('PROTO (spore contagion)', true)

// R0 probe: one seeded infected in a line of clean crew — how many does the
// first host turn before dying? (spread rate legibility)
console.log('\n═══ R0 probe: 1 host in a crew line ═══')
{
  const w = makeArena(3, 16, false)
  w.proto = { infection: true }
  const c = center(w)
  const host = addNpc(w, 'thug', c.x, c.y, { sight: 10, speed: 2.5 })
  host.infected = true
  host.ai!.behavior = 'infected'
  host.ai!.mode = 'aggro'
  for (let i = 1; i <= 8; i++) addNpc(w, 'civilian', c.x + i * 1.6, c.y, { behavior: 'skittish', sight: 8 })
  const input = new Map([[0, emptyInput()]])
  let peak = 0
  for (let t = 0; t < 600; t++) {
    tickWorld(w, input)
    peak = Math.max(peak, w.entities.filter((e) => e.infected && !e.dead).length)
  }
  console.log(`  seeded 1 host among 8 clean → peak infected=${peak} (chain reaction from a single vector)`)
}
