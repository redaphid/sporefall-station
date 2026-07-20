// Baseline AI behaviour measurement (the SHIPPED brain, untouched). Composes a
// battery of deterministic scenarios, runs the real systems, and prints the
// metrics that the Sporefall AI redesign is judged against — above all the #59
// goal-thrash rate.
//
//   npx tsx scripts/test/ai-sim/baseline.ts

import { addNpc, addPlayer, center, fmt, makeArena, measure, wall, type Metrics } from './arena'
import type { World } from '../../../src/game/world'

const results: [string, Metrics][] = []
const run = (label: string, w: World, ticks: number, input?: Parameters<typeof measure>[1]['input'], onTick?: Parameters<typeof measure>[1]['onTick']): Metrics => {
  const m = measure(w, { ticks, input, onTick })
  results.push([label, m])
  console.log(fmt(m, label))
  return m
}

// ── 1. The #59 repro: a single mid-health hostile taking chip damage ─────────
// A gangster whose HP sits near the battle/flee crossover (max/3) while the
// armed player fires on it. Its goal should oscillate battle<->flee<->pursue.
for (const frac of [0.2, 0.34, 0.5, 0.75, 1.0]) {
  const w = makeArena(1234)
  const c = center(w)
  const p = addPlayer(w, c.x, c.y)
  p.combat!.weapon = 'pistol'
  p.playerCtl!.inventory = [{ itemId: 'pistol', qty: 99999 }]
  p.playerCtl!.activeSlot = 0
  const g = addNpc(w, 'gangster', c.x + 6, c.y, { sight: 12 })
  g.health = { hp: Math.round(g.health!.max * frac), max: g.health!.max, iframes: 0 }
  const input = new Map([[0, { attack: true, aimX: 1, aimY: 0 }]])
  run(`#59 duel hp=${(frac * 100).toFixed(0)}%`, w, 300, input)
}

// ── 2. Faction clash: cops vs gang, lots of mutual HP crossing thresholds ────
{
  const w = makeArena(22, 24)
  const c = center(w)
  for (let i = 0; i < 6; i++) addNpc(w, 'cop', c.x - 8, c.y - 5 + i * 2, { sight: 12, weapon: 'pistol' })
  for (let i = 0; i < 6; i++) addNpc(w, 'gangster', c.x + 8, c.y - 5 + i * 2, { sight: 12, weapon: 'pistol' })
  run('faction clash 6v6', w, 400)
}

// ── 3. Hostile crowd around a player (the common play case) ──────────────────
{
  const w = makeArena(77, 24)
  const c = center(w)
  addPlayer(w, c.x, c.y)
  let id = 0
  for (const arch of ['thug', 'gangster', 'cop', 'civilian', 'thug', 'gangster', 'robot', 'thug']) {
    const a = (id / 8) * Math.PI * 2
    addNpc(w, arch, c.x + Math.cos(a) * 10, c.y + Math.sin(a) * 10, { sight: 12 })
    id++
  }
  run('hostile crowd 8', w, 400)
}

// ── 4. Chase readability: hunter vs fleeing civ around an L-wall ─────────────
{
  const w = makeArena(88, 20)
  const c = center(w)
  wall(w, Math.floor(c.x), Math.floor(c.y) - 4, Math.floor(c.x), Math.floor(c.y) + 1) // vertical
  wall(w, Math.floor(c.x) - 4, Math.floor(c.y) - 4, Math.floor(c.x), Math.floor(c.y) - 4) // horizontal
  const prey = addNpc(w, 'civilian', c.x - 6, c.y + 3, { behavior: 'skittish', sight: 8 })
  prey.ai!.mode = 'flee'
  const hunter = addNpc(w, 'gangster', c.x + 6, c.y + 3, { behavior: 'hunter', sight: 10 })
  hunter.ai!.rel = { [prey.id]: { hate: 40, code: 'Hostile' } }
  hunter.ai!.mode = 'aggro'
  hunter.ai!.targetId = prey.id
  const m = run('hunter vs prey (L-wall)', w, 400)
  const caught = prey.dead || Math.hypot(prey.pos.x - hunter.pos.x, prey.pos.y - hunter.pos.y) < 2
  console.log(`    -> caught=${caught} finalGap=${Math.hypot(prey.pos.x - hunter.pos.x, prey.pos.y - hunter.pos.y).toFixed(1)}`)
}

// ── 5. Chokepoint swarm: 12 hostiles must funnel through a 1-wide gap ────────
{
  const w = makeArena(99, 22)
  const c = center(w)
  const wx = Math.floor(c.x)
  for (let y = Math.floor(c.y) - 10; y <= Math.floor(c.y) + 10; y++) {
    if (y === Math.floor(c.y)) continue // the gap
    wall(w, wx, y, wx, y)
  }
  addPlayer(w, c.x - 6, c.y)
  for (let i = 0; i < 12; i++) addNpc(w, 'thug', c.x + 4 + (i % 4), c.y - 4 + Math.floor(i / 4) * 3, { sight: 16 })
  const m = run('chokepoint swarm 12', w, 500)
  console.log(`    -> finalSpread=${m.finalSpread.toFixed(1)} (clumping at the gap)`)
}

// ── 6. Cornered 1-vs-many: a lone civ boxed by hostiles (degenerate flee) ────
{
  const w = makeArena(55, 16)
  const c = center(w)
  wall(w, Math.floor(c.x) - 2, Math.floor(c.y) - 2, Math.floor(c.x) + 2, Math.floor(c.y) - 2)
  wall(w, Math.floor(c.x) - 2, Math.floor(c.y) + 2, Math.floor(c.x) + 2, Math.floor(c.y) + 2)
  wall(w, Math.floor(c.x) - 2, Math.floor(c.y) - 2, Math.floor(c.x) - 2, Math.floor(c.y) + 2)
  const victim = addNpc(w, 'civilian', c.x, c.y, { behavior: 'skittish' })
  victim.ai!.mode = 'flee'
  addPlayer(w, c.x + 1.5, c.y)
  for (let i = 0; i < 3; i++) addNpc(w, 'thug', c.x + 1.5, c.y - 1 + i, { sight: 10 })
  run('cornered civ', w, 300)
}

console.log('\n== BASELINE SUMMARY ==')
let totalFlips = 0
let totalBF = 0
for (const [, m] of results) {
  totalFlips += m.goalFlips
  totalBF += m.battleFleeFlips
}
console.log(`total goal flips=${totalFlips}  battle<->flee flips=${totalBF}`)
