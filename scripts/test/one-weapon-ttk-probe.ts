// One-weapon TTK probe: how long does the pistol REALLY take to kill each
// enemy, now that the pistol is the whole arsenal?
//
// Two measurements, because they answer different questions:
//
//   ANALYTIC  — shots-to-kill straight through `applyDamage`, spaced by the
//               pistol cooldown. Perfect aim, every shot lands, target never
//               moves. This is the theoretical FLOOR.
//   LIVE FIRE — a real player entity holding FIRE at a real, live, approaching
//               enemy in a real world: the actual fire system, projectile
//               travel time, hit detection, i-frames and AI movement. This is
//               what the player's thumb actually experiences.
//
//   npx tsx scripts/test/one-weapon-ttk-probe.ts

import { NPCS } from '../../src/game/data/npcs'
import { WEAPONS } from '../../src/game/data/items'
import { spawnNpc } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { applyDamage } from '../../src/game/systems/combat'
import { emptyInput, type InputCmd } from '../../src/game/types'
import { createWorld, tickWorld, type World } from '../../src/game/world'
import type { Entity } from '../../src/game/entity'

const TPS = 30
const ARCHES = ['thug', 'gangster', 'cinder', 'robot', 'brute', 'boss'] as const

// ---------------------------------------------------------------- analytic --
/** Shots to kill, measured through applyDamage so `resist` is honoured exactly
 * as in play (including the Math.round on the resisted amount). */
const shotsToKill = (arch: string, dmg: number): number => {
  const w = createWorld(7, 1)
  const e = spawnNpc(w, arch, 5, 5)
  let shots = 0
  while (!e.dead && e.health && e.health.hp > 0 && shots < 10000) {
    e.health.iframes = 0 // the pistol's 14-tick cadence already clears the 5-tick i-frame
    applyDamage(w, e, dmg, 0, 0, 0, 999)
    shots++
  }
  return shots
}

/** Seconds of perfect, uninterrupted fire: the gap between N shots at 30tps. */
const analyticSeconds = (shots: number, cd: number): number => ((shots - 1) * cd) / TPS

// --------------------------------------------------------------- live fire --
/** Find a walkable tile near the spawn that a spawned NPC will actually sit on. */
const placeNear = (w: World, arch: string, sx: number, sy: number): Entity | undefined => {
  for (const [dx, dy] of [
    [3, 0], [-3, 0], [0, 3], [0, -3],
    [2, 0], [-2, 0], [0, 2], [0, -2],
    [2, 2], [-2, -2], [4, 0], [-4, 0],
  ] as const) {
    const e = spawnNpc(w, arch, sx + dx, sy + dy)
    if (e) return e
  }
  return undefined
}

/**
 * Hold FIRE at a live enemy until it dies. The player is given an enormous HP
 * pool so the measurement is "how long to kill it", not "who wins" — otherwise
 * a brute simply beats the player to death and there is no TTK to report.
 * Returns ticks from the first tick of fire to the enemy's death.
 */
const liveFireTicks = (arch: string, seed: number): number | undefined => {
  const w = createWorld(seed, 1)
  const sp = w.level.spawn
  const p = spawnPlayer(w, 0, sp.x, sp.y)
  if (!p) return undefined
  if (p.health) {
    p.health.hp = 1_000_000
    p.health.max = 1_000_000
  }
  const foe = placeNear(w, arch, sp.x, sp.y)
  if (!foe) return undefined

  const LIMIT = 60 * TPS // 60s bail-out
  for (let t = 0; t < LIMIT; t++) {
    if (foe.dead || !foe.health || foe.health.hp <= 0) return t
    // Aim straight at the target every tick: a perfectly accurate player.
    const dx = foe.pos.x - p.pos.x
    const dy = foe.pos.y - p.pos.y
    const len = Math.hypot(dx, dy) || 1
    const cmd: InputCmd = { ...emptyInput(), attack: true, aimX: dx / len, aimY: dy / len }
    // Keep the player topped up: we are measuring the enemy's lifespan.
    if (p.health) p.health.hp = 1_000_000
    tickWorld(w, new Map([[0, cmd]]))
  }
  return undefined
}

// ------------------------------------------------------------------ report --
const dmg = WEAPONS.pistol.damage
const cd = WEAPONS.pistol.cooldownTicks
console.log(`pistol: ${dmg} dmg / ${cd} ticks = ${((TPS / cd) * dmg).toFixed(1)} dps  (range ${WEAPONS.pistol.range}, projectileSpeed ${WEAPONS.pistol.projectileSpeed})`)
console.log('')
console.log('enemy        hp   resist.physical  perHit  shots  analytic(s)   live-fire(s)   [median of 5 seeds]')

for (const arch of ARCHES) {
  const def = NPCS[arch]
  const res = def.resist?.physical ?? 1
  const perHit = Math.round(dmg * res)
  const shots = shotsToKill(arch, dmg)

  const live: number[] = []
  for (const seed of [11, 22, 33, 44, 55]) {
    const ticks = liveFireTicks(arch, seed)
    if (ticks !== undefined) live.push(ticks / TPS)
  }
  live.sort((a, b) => a - b)
  const median = live.length ? live[Math.floor(live.length / 2)] : undefined
  const spread = live.length ? `${live[0].toFixed(2)}–${live[live.length - 1].toFixed(2)}` : '—'

  console.log(
    `${arch.padEnd(11)} ${String(def.hp).padStart(4)}   ${String(res).padStart(15)}  ${String(perHit).padStart(6)}  ${String(shots).padStart(5)}  ${analyticSeconds(shots, cd).toFixed(2).padStart(10)}   ${(median !== undefined ? median.toFixed(2) : 'n/a').padStart(12)}   (${spread}, n=${live.length})`,
  )
}
