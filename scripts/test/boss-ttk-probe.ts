// Boss presence probe: time-to-kill through the REAL damage path, and how much
// of the boss's own phase machinery a player can ever witness.
//
// Reports TTK in two worlds: this branch's pistol, and the feat/one-weapon
// pistol (18 dmg / 14 ticks) the player will actually be holding.
//
//   npx tsx scripts/test/boss-ttk-probe.ts

import { NPCS } from '../../src/game/data/npcs'
import { WEAPONS } from '../../src/game/data/items'
import { spawnNpc } from '../../src/game/populate'
import { applyDamage } from '../../src/game/systems/combat'
import { MIRECLAW_ENRAGE_FRAC, MIRECLAW_RETREAT_FRAC } from '../../src/game/systems/behaviors'
import { SUMMON_INTERVAL } from '../../src/game/systems/mireclaw'
import { emptyInput } from '../../src/game/types'
import { createWorld, tickWorld } from '../../src/game/world'

/** Shots to kill `arch` with a weapon of `dmg` per hit, measured through
 * applyDamage so archetype `resist` is honoured exactly as in play. */
const shotsToKill = (arch: string, dmg: number): number => {
  const w = createWorld(7, 1)
  const e = spawnNpc(w, arch, 5, 5)
  let shots = 0
  while (!e.dead && e.health && e.health.hp > 0 && shots < 10000) {
    e.health.iframes = 0
    applyDamage(w, e, dmg, 0, 0, 0, 999)
    shots++
  }
  return shots
}

/** Seconds of perfect, uninterrupted fire: the gap between N shots at 30tps. */
const ttkSeconds = (shots: number, cooldownTicks: number): number => ((shots - 1) * cooldownTicks) / 30

const table = (label: string, dmg: number, cd: number): void => {
  console.log(`\n=== ${label} — pistol ${dmg} dmg / ${cd} ticks (${((30 / cd) * dmg).toFixed(1)} dps) ===`)
  console.log('enemy       hp   physResist  shots   TTK(s)')
  for (const arch of ['thug', 'gangster', 'cinder', 'robot', 'brute', 'boss']) {
    const def = NPCS[arch]
    const s = shotsToKill(arch, dmg)
    console.log(
      `${arch.padEnd(11)} ${String(def.hp).padStart(3)}   ${String(def.resist?.physical ?? 1).padStart(10)}  ${String(s).padStart(5)}   ${ttkSeconds(s, cd).toFixed(2)}`,
    )
  }
}

table('this branch', WEAPONS.pistol.damage, WEAPONS.pistol.cooldownTicks)
table('feat/one-weapon (incoming)', 18, 14)

// --- How much of the phase machinery is reachable? --------------------------
const boss = NPCS.boss
const oneWeaponShots = shotsToKill('boss', 18)
const p1 = Math.round(oneWeaponShots * (1 - MIRECLAW_RETREAT_FRAC))
const p2 = Math.round(oneWeaponShots * (MIRECLAW_RETREAT_FRAC - MIRECLAW_ENRAGE_FRAC))
const p3 = Math.round(oneWeaponShots * MIRECLAW_ENRAGE_FRAC)
console.log(`\n=== phase budget at hp ${boss.hp} (one-weapon pistol, ${oneWeaponShots} shots total) ===`)
console.log(`phase 1 (summon)   ${p1} shots  ${((p1 * 14) / 30).toFixed(1)}s   summon every ${(SUMMON_INTERVAL / 30).toFixed(1)}s`)
console.log(`phase 2 (regen)    ${p2} shots  ${((p2 * 14) / 30).toFixed(1)}s`)
console.log(`phase 3 (enrage)   ${p3} shots  ${((p3 * 14) / 30).toFixed(1)}s`)

// --- Does the summon fire before the player has ever seen the boss? ---------
// Build a real boss floor and tick it with the player parked at the spawn tile,
// i.e. nowhere near the objective room. Count the brood that accumulates.
const w = createWorld(1003, 5)
// find a seed/floor that actually rolled a boss
let world = w
for (let s = 1000; s < 1100; s++) {
  const cand = createWorld(s, 5)
  const { populateWorld } = await import('../../src/game/populate')
  const { setupFloor } = await import('../../src/game/systems/missions')
  populateWorld(cand)
  setupFloor(cand)
  if (cand.entities.some((e) => e.archetype === 'boss')) {
    world = cand
    break
  }
}
const input = new Map([[0, emptyInput()]])
const bossEnt = world.entities.find((e) => e.archetype === 'boss')!
const brood = (): number =>
  world.entities.filter(
    (e) =>
      e.archetype === 'sporeling' &&
      !e.dead &&
      Math.hypot(e.pos.x - bossEnt.pos.x, e.pos.y - bossEnt.pos.y) <= 6,
  ).length
console.log(`\n=== brood accumulated with NO player present (seed ${world.seed}, floor 5) ===`)
for (const t of [0, 30, 90, 300, 900, 1800]) {
  while (world.tick < t) tickWorld(world, input)
  console.log(`  tick ${String(t).padStart(4)} (${(t / 30).toFixed(0).padStart(2)}s): brood near boss = ${brood()}`)
}
