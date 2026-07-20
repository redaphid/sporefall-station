// Shipped-AI regression evidence. Runs the SAME deterministic scenarios with the
// SHIPPED brain (features ON — the default) vs the OLD brain (the feature forced
// off via `w.aiFlags`), printing the deltas that justify #62 (goal hysteresis)
// and #63 (NPC-vs-NPC autonomy). These features now ship ON by default; the
// force-off path exists only for this A/B measurement.
//
//   npx tsx scripts/test/ai-sim/compare.ts

import { addNpc, addPlayer, center, decide, fmt, makeArena, measure, wall } from './arena'
import type { World } from '../../../src/game/world'

type Flags = NonNullable<World['aiFlags']>
const withFlags = (w: World, f: Flags): World => {
  w.aiFlags = f
  return w
}

// ── Scenario builders (identical entities each call; only the flags differ) ──

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

// `off` forces the OLD behaviour for the "before" column; the "after" column is
// the shipped default (all flags on).
const compare = (name: string, build: (s: number) => World, off: Flags, ticks: number): void => {
  const before = measure(withFlags(build(1), off), { ticks })
  const after = measure(build(1), { ticks }) // shipped default
  console.log(`\n### ${name}`)
  console.log(fmt(before, '  OLD (forced off)'))
  console.log(fmt(after, '  SHIPPED (default on)'))
  const dChg = before.goalChanges === 0 ? 0 : ((after.goalChanges - before.goalChanges) / before.goalChanges) * 100
  console.log(
    `  Δ goalChanges ${after.goalChanges - before.goalChanges} (${dChg.toFixed(0)}%)  Δ b<->f ${
      after.battleFleeFlips - before.battleFleeFlips
    }  Δ hits ${after.hits - before.hits}  Δ deaths ${after.deaths - before.deaths}`,
  )
}

console.log('═══ #62 HYSTERESIS (fixes #59) ═══')
compare('crowd 8', crowd, { hysteresis: false }, 400)
compare('boundary duel', boundaryDuel, { hysteresis: false }, 400)
compare('chokepoint 12', chokepoint, { hysteresis: false }, 500)

console.log('\n═══ #63 NPC-vs-NPC autonomy (dead faction matrix) ═══')
// OLD = npcVsNpc off (players-only threat); SHIPPED = the faction matrix awake.
compare('faction clash 6v6', factionClash, { npcVsNpc: false }, 500)

// Analytic proof that hysteresis kills the 1-hp boundary reversal.
console.log('\n═══ #62 analytic (battle/flee 1-hp jitter) ═══')
{
  for (const hyst of [false, true]) {
    const w = makeArena(1)
    const c = center(w)
    addPlayer(w, c.x, c.y)
    const g = addNpc(w, 'gangster', c.x + 6, c.y, { sight: 12 })
    w.aiFlags = { hysteresis: hyst }
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
