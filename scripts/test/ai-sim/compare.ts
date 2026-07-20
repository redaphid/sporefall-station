// Prototype vs baseline comparison. Runs the SAME deterministic scenarios with
// the shipped brain and with each Sporefall proto flag, printing the deltas that
// justify the redesign issues. Nothing is merged — flags default off.
//
//   npx tsx scripts/test/ai-sim/compare.ts

import { addNpc, addPlayer, center, decide, fmt, makeArena, measure, wall } from './arena'
import type { World } from '../../../src/game/world'

type Proto = NonNullable<World['proto']>
const set = (w: World, p: Proto): World => {
  w.proto = p
  return w
}

// ── Scenario builders (identical entities each call; only the flag differs) ──

const crowd = (seed: number): World => {
  const w = makeArena(seed, 24)
  const c = center(w)
  addPlayer(w, c.x, c.y)
  let i = 0
  for (const arch of ['thug', 'gangster', 'cop', 'civilian', 'thug', 'gangster', 'robot', 'thug']) {
    const a = (i / 8) * Math.PI * 2
    addNpc(w, arch, c.x + Math.cos(a) * 10, c.y + Math.sin(a) * 10, { sight: 12 })
    i++
  }
  return w
}

// A hostile parked right at the battle<->pursue boundary (dist == ENGAGE_RANGE),
// strafing so its distance jitters across it every think — the per-think thrash.
const boundaryDuel = (seed: number): World => {
  const w = makeArena(seed, 20)
  const c = center(w)
  addPlayer(w, c.x, c.y)
  const g = addNpc(w, 'gangster', c.x + 13, c.y, { sight: 16, weapon: 'pistol' })
  g.health = { hp: Math.round(g.health!.max / 3) + 1, max: g.health!.max, iframes: 0 } // near the flee edge too
  return w
}

const factionClash = (seed: number): World => {
  const w = makeArena(seed, 24)
  const c = center(w)
  for (let i = 0; i < 6; i++) addNpc(w, 'cop', c.x - 8, c.y - 5 + i * 2, { sight: 13, weapon: 'pistol' })
  for (let i = 0; i < 6; i++) addNpc(w, 'gangster', c.x + 8, c.y - 5 + i * 2, { sight: 13, weapon: 'pistol' })
  return w
}

const chokepoint = (seed: number): World => {
  const w = makeArena(seed, 22)
  const c = center(w)
  const wx = Math.floor(c.x)
  for (let y = Math.floor(c.y) - 10; y <= Math.floor(c.y) + 10; y++) if (y !== Math.floor(c.y)) wall(w, wx, y, wx, y)
  addPlayer(w, c.x - 6, c.y)
  for (let i = 0; i < 12; i++) addNpc(w, 'thug', c.x + 4 + (i % 4), c.y - 4 + Math.floor(i / 4) * 3, { sight: 16 })
  return w
}

const compare = (name: string, build: (s: number) => World, flag: Proto, ticks: number): void => {
  const base = measure(build(1), { ticks })
  const proto = measure(set(build(1), flag), { ticks })
  console.log(`\n### ${name}`)
  console.log(fmt(base, '  baseline'))
  console.log(fmt(proto, `  proto ${JSON.stringify(flag)}`))
  const dChg = base.goalChanges === 0 ? 0 : ((proto.goalChanges - base.goalChanges) / base.goalChanges) * 100
  console.log(
    `  Δ goalChanges ${proto.goalChanges - base.goalChanges} (${dChg.toFixed(0)}%)  Δ b<->f ${
      proto.battleFleeFlips - base.battleFleeFlips
    }  Δ hits ${proto.hits - base.hits}  Δ deaths ${proto.deaths - base.deaths}`,
  )
}

console.log('═══ HYSTERESIS (#59) ═══')
compare('crowd 8', crowd, { hysteresis: true }, 400)
compare('boundary duel', boundaryDuel, { hysteresis: true }, 400)
compare('chokepoint 12', chokepoint, { hysteresis: true }, 500)

console.log('\n═══ NPC-vs-NPC autonomy (dead faction matrix) ═══')
compare('faction clash 6v6', factionClash, { npcVsNpc: true }, 500)

// Analytic proof that hysteresis kills the 1-hp boundary reversal.
console.log('\n═══ HYSTERESIS analytic (battle/flee 1-hp jitter) ═══')
{
  for (const hyst of [false, true]) {
    const w = makeArena(1)
    const c = center(w)
    addPlayer(w, c.x, c.y)
    const g = addNpc(w, 'gangster', c.x + 6, c.y, { sight: 12 })
    w.proto = { hysteresis: hyst }
    const b = 11 // the crossover hp from probe-decide
    let flips = 0
    let prev = ''
    // Simulate the goal being re-decided while hp bounces b+1 <-> b every think.
    for (let k = 0; k < 20; k++) {
      g.health!.hp = k % 2 === 0 ? b + 1 : b
      const goal = decide(w, g).goal.code
      g.ai!.goal = goal // becomes the incumbent for the next think (as the sim does)
      g.ai!.targetId = decide(w, g).goal.target
      if (prev && goal !== prev) flips++
      prev = goal
    }
    console.log(`  hysteresis=${hyst}: ${flips} flips over 20 boundary-jitter thinks`)
  }
}
