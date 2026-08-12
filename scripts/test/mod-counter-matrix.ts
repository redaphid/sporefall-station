// Does the ROCK-PAPER-SCISSORS survive on MODS alone?
//
// The design question: the roster's counters used to be carried by WEAPONS
// ("burn the brute, shoot the cinder"). With one permanent pistol, the claim is
// that MODS carry them instead — a pistol with an elemental is a different gun.
// If that is true, the branch's HP nerf (brute 95→68, robot 70→52) may be
// solving a problem the mods already solve, and the two fixes would COMPOUND
// into a game that is trivially easy. Nothing fails a test for "too easy".
//
// So: measure time-to-kill in a matrix of {no mod, wrong mod, right mod} x
// {original HP, branch HP}. The SPREAD between no-mod and right-mod is the
// mechanic. A big spread means mods are doing the work; a flat row means they
// are not.
//
// Everything here is LIVE FIRE through the real systems — real player, real
// pistol, real projectiles, real status effects, real AI — not arithmetic.
//
//   npx tsx scripts/test/mod-counter-matrix.ts

import { NPCS } from '../../src/game/data/npcs'
import { ELEMENTS } from '../../src/game/data/elements'
import { WEAPONS } from '../../src/game/data/items'
import { spawnNpc } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { applyModPickup } from '../../src/game/systems/inventory'
import { emptyInput, type InputCmd } from '../../src/game/types'
import { createWorld, tickWorld, type World } from '../../src/game/world'
import type { Entity } from '../../src/game/entity'

const TPS = 30
const SEEDS = [11, 22, 33, 44, 55]
const LIMIT = 90 * TPS // 90s bail-out

/** Original, pre-branch HP values (from git history of data/npcs.ts). */
const ORIGINAL_HP: Record<string, number> = { brute: 95, robot: 70, cinder: 45, thug: 40 }

const placeNear = (w: World, arch: string, sx: number, sy: number): Entity | undefined => {
  for (const [dx, dy] of [[3, 0], [-3, 0], [0, 3], [0, -3], [2, 0], [-2, 0], [0, 2], [0, -2], [4, 0], [-4, 0]] as const) {
    const e = spawnNpc(w, arch, sx + dx, sy + dy)
    if (e) return e
  }
  return undefined
}

/** Seconds for a mod-loadout to kill `arch` at a forced HP, by live fire. */
const ttk = (arch: string, hp: number, mods: string[], seed: number): number | undefined => {
  const w = createWorld(seed, 1)
  const sp = w.level.spawn
  const p = spawnPlayer(w, 0, sp.x, sp.y)
  if (!p) return undefined
  for (const m of mods) applyModPickup(p, m)

  const foe = placeNear(w, arch, sp.x, sp.y)
  if (!foe || !foe.health) return undefined
  foe.health.hp = hp
  foe.health.max = hp

  for (let t = 0; t < LIMIT; t++) {
    if (foe.dead || !foe.health || foe.health.hp <= 0) return t / TPS
    const dx = foe.pos.x - p.pos.x
    const dy = foe.pos.y - p.pos.y
    const len = Math.hypot(dx, dy) || 1
    // The player is kept alive so we measure the ENEMY's lifespan, not who wins.
    if (p.health) { p.health.hp = 1_000_000; p.health.max = 1_000_000 }
    const cmd: InputCmd = { ...emptyInput(), attack: true, aimX: dx / len, aimY: dy / len }
    tickWorld(w, new Map([[0, cmd]]))
  }
  return undefined
}

/** Median across seeds, so one unlucky pathing seed cannot set the headline. */
const medianTtk = (arch: string, hp: number, mods: string[]): string => {
  const xs: number[] = []
  for (const s of SEEDS) {
    const v = ttk(arch, hp, mods, s)
    if (v !== undefined) xs.push(v)
  }
  if (!xs.length) return '  >90s'
  xs.sort((a, b) => a - b)
  return `${xs[Math.floor(xs.length / 2)].toFixed(2)}s`.padStart(6)
}

// ------------------------------------------------------------------ report --
console.log(`pistol ${WEAPONS.pistol.damage} dmg / ${WEAPONS.pistol.cooldownTicks} ticks = ${((TPS / WEAPONS.pistol.cooldownTicks) * WEAPONS.pistol.damage).toFixed(1)} dps`)
console.log('')
console.log('HOW THE COUNTER ACTUALLY WORKS (verified in code, not assumed):')
console.log('  applyDamage() hardcodes resistMult(target, "physical") — an elemental mod does')
console.log('  NOT re-type the bullet. Impact damage stays physical and stays resisted.')
console.log('  What a mod adds is an onHit STATUS, whose damage-over-time is resisted')
console.log('  separately by that element\'s own multiplier in elementSystem().')
for (const k of ['burning', 'poisoned', 'frozen', 'electrified']) {
  const d = ELEMENTS[k]
  console.log(`    ${k.padEnd(13)} dot ${d.dot}/${d.interval}t  duration ${d.durationTicks}t`)
}
console.log('')
console.log('  So vs a brute (physical 0.35, burning 1.5):')
const brutePhys = Math.round(WEAPONS.pistol.damage * 0.35)
const bruteBurnDps = (Math.round(ELEMENTS.burning.dot * 1.5) * TPS) / ELEMENTS.burning.interval
console.log(`    bullets  ${brutePhys} dmg / 14t = ${((brutePhys * TPS) / 14).toFixed(1)} dps  (18 x 0.35, rounded)`)
console.log(`    burning  ${Math.round(ELEMENTS.burning.dot * 1.5)} dmg / 9t  = ${bruteBurnDps.toFixed(1)} dps  (2 x 1.5, rounded) — an ADDITIVE second channel`)
console.log('')

const CASES: { arch: string; right: string; wrong: string }[] = [
  { arch: 'brute', right: 'incendiary', wrong: 'shock' },
  { arch: 'robot', right: 'incendiary', wrong: 'shock' },
  { arch: 'cinder', right: 'shock', wrong: 'incendiary' },
]

// --- The frost sweep -------------------------------------------------------
// This sweep caught the branch's worst bug and now guards the fix. `applyDamage`
// used to shatter ANY frozen non-player outright — hp = 0, no HP check, no resist
// check, no archetype guard — so Cryo Rounds deleted a 320hp boss as fast as a
// 40hp thug (0.63s both). Shatter is now scoped to BRITTLE ice (a thrown freeze
// grenade); the mod's freeze cracks for bonus damage instead. The column below
// must therefore SCALE WITH HP again: if a big pool and a small pool ever read
// the same number here, an HP-independent effect has come back.
console.log('=== FROST SWEEP — does the frost payoff respect the stat block? ===')
console.log('enemy        hp   resist.physical   no mod    frost')
for (const arch of ['thug', 'cinder', 'robot', 'brute', 'boss']) {
  const def = NPCS[arch]
  console.log(
    `${arch.padEnd(11)} ${String(def.hp).padStart(4)}   ${String(def.resist?.physical ?? 1).padStart(15)}   ${medianTtk(arch, def.hp, [])}   ${medianTtk(arch, def.hp, ['frost'])}`,
  )
}
console.log('')

for (const { arch, right, wrong } of CASES) {
  const def = NPCS[arch]
  const orig = ORIGINAL_HP[arch] ?? def.hp
  console.log(`=== ${arch.toUpperCase()}  (resist: ${JSON.stringify(def.resist ?? {})}) ===`)
  console.log(`                        original hp ${String(orig).padStart(3)}   branch hp ${String(def.hp).padStart(3)}   delta`)
  const rows: [string, string[]][] = [
    ['no mod', []],
    [`wrong mod (${wrong})`, [wrong]],
    [`RIGHT mod (${right})`, [right]],
    ['frost (freeze -> crack)', ['frost']],
  ]
  for (const [label, mods] of rows) {
    const a = medianTtk(arch, orig, mods)
    const b = medianTtk(arch, def.hp, mods)
    const an = parseFloat(a), bn = parseFloat(b)
    const delta = isNaN(an) || isNaN(bn) ? '     —' : `${(bn - an).toFixed(2)}s`.padStart(7)
    console.log(`  ${label.padEnd(24)} ${a}        ${b}   ${delta}`)
  }
  console.log('')
}
