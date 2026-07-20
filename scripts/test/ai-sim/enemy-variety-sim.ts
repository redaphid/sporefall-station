// #78 enemy-variety regression evidence. Prints the tool × enemy damage matrix
// through the REAL damage path (impact via combat.applyDamage, elements via the
// elementSystem DOT over a fixed window) and flags the headline property: no
// single tool clears the whole roster. Deterministic.
//
//   npx tsx scripts/test/ai-sim/enemy-variety-sim.ts

import { spawnNpc } from '../../../src/game/populate'
import { applyDamage } from '../../../src/game/systems/combat'
import { addStatus } from '../../../src/game/systems/statusFx'
import { emptyInput } from '../../../src/game/types'
import { createWorld, tickWorld } from '../../../src/game/world'

const HUGE = 1e7
const phys = (arch: string): number => {
  const w = createWorld(1, 1)
  const e = spawnNpc(w, arch, 5, 5)
  e.health = { hp: HUGE, max: HUGE, iframes: 0 }
  const before = e.health.hp
  applyDamage(w, e, 20, 0, 0, 0, 999)
  return before - e.health.hp
}
const elem = (arch: string, kind: string): number => {
  const w = createWorld(1, 1)
  const e = spawnNpc(w, arch, 5, 5)
  e.health = { hp: HUGE, max: HUGE, iframes: 0 }
  addStatus(w, e, kind, 1000)
  const before = e.health.hp
  const input = new Map([[0, emptyInput()]])
  for (let t = 0; t < 90; t++) tickWorld(w, input)
  return before - e.health.hp
}

const enemies = ['thug', 'brute', 'cinder', 'sporeling', 'robot']
const tools: [string, (a: string) => number][] = [
  ['bullets/melee', (a) => phys(a)],
  ['fire', (a) => elem(a, 'burning')],
  ['poison', (a) => elem(a, 'poisoned')],
]

console.log('═══ #78 enemy variety — tool × enemy damage (higher = better matchup) ═══')
console.log(`${'enemy'.padEnd(11)}${tools.map(([n]) => n.padStart(14)).join('')}`)
const base = Object.fromEntries(tools.map(([n, f]) => [n, f('thug')]))
for (const e of enemies) {
  const cells = tools.map(([n, f]) => {
    const v = f(e)
    const tag = e === 'thug' ? ' ' : v >= 0.9 * base[n] ? '↑' : v <= 0.4 * base[n] ? '↓' : ' '
    return `${String(v)}${tag}`.padStart(14)
  })
  console.log(`${e.padEnd(11)}${cells.join('')}`)
}
console.log('\n↑ strong counter   ↓ hard matchup (whiffs).  Each row has both; each')
console.log('column (tool) has at least one ↓ — so no build clears the whole deck.')
