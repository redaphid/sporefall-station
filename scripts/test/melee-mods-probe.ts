// "The melee weapons couldn't have mods, right? Or maybe we have a 'lightsaber'
// that can" — answering that with facts rather than a guess.
//
// `ModDef` has no weapon-scoping field at all, so nothing STOPS a mod going onto
// a melee weapon. The real question is which ones then do anything. `fireWeapon`
// takes a different branch for melee: it reads the resolved damage, cooldown,
// knockback, onHit and triggers — but it never builds a `projectileSpec`,
// because there is no projectile. Every mod whose whole effect lives on the
// bullet is therefore silently inert.
//
// That is the same shape as everything else found tonight: the mod equips, the
// UI shows it, and it does nothing.
//
//   npx tsx scripts/test/melee-mods-probe.ts

import { MODS } from '../../src/game/data/mods'
import { WEAPONS } from '../../src/game/data/items'
import { spawnNpc } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { resolveWeapon } from '../../src/game/systems/resolveWeapon'
import { emptyInput, type InputCmd } from '../../src/game/types'
import { createWorld, tickWorld, type World } from '../../src/game/world'
import type { Entity } from '../../src/game/entity'

const TPS = 30
const BAT = WEAPONS.bat

/** Which resolved fields does a melee swing actually READ? (combat.ts fireWeapon,
 * melee branch: damage, cooldownTicks, knockback, onHit, triggers — and nothing
 * else, because projectileSpec is only built on the ranged path.) */
const MELEE_READS = ['damage', 'cooldownTicks', 'knockback', 'onHit', 'triggers'] as const

console.log('=== DO MODS APPLY TO MELEE? ===')
console.log('`ModDef` has no weapon-scoping field, so every mod can be equipped on a melee')
console.log('weapon. This is which ones actually DO anything once equipped.\n')
console.log('mod             category   effect on a BAT')

const base = resolveWeapon(BAT, undefined)
const live: string[] = []
const inert: string[] = []

for (const m of Object.values(MODS)) {
  const rw = resolveWeapon(BAT, [{ id: m.id, stacks: 1 }])
  const changes: string[] = []
  if (rw.damage !== base.damage) changes.push(`damage ${base.damage}->${rw.damage}`)
  if (rw.cooldownTicks !== base.cooldownTicks) changes.push(`cooldown ${base.cooldownTicks}->${rw.cooldownTicks}`)
  if (rw.knockback !== base.knockback) changes.push(`knockback ${base.knockback}->${rw.knockback}`)
  if (rw.onHit && !base.onHit) changes.push(`onHit ${rw.onHit.status}`)
  if (rw.triggers.length !== base.triggers.length) changes.push(`trigger x${rw.triggers.length}`)

  // Anything it changed that the melee branch never reads is dead weight.
  const deadFields: string[] = []
  if (rw.pellets !== base.pellets) deadFields.push('pellets')
  if (rw.spread !== base.spread) deadFields.push('spread')
  if (rw.projectileSpeed !== base.projectileSpeed) deadFields.push('projectileSpeed')
  for (const k of ['pierce', 'bounce', 'homing', 'explodeRadius', 'split', 'splinter', 'lifestealFrac'] as const) {
    if (rw.behavior[k] !== base.behavior[k]) deadFields.push(k)
  }

  const verdict = changes.length
    ? `WORKS  — ${changes.join(', ')}${deadFields.length ? `  (+dead: ${deadFields.join('/')})` : ''}`
    : `INERT  — sets ${deadFields.join('/') || 'nothing'}, which a melee swing never reads`
  if (changes.length) live.push(m.id)
  else inert.push(m.id)
  console.log(`${m.icon} ${m.id.padEnd(14)} ${m.category.padEnd(9)}  ${verdict}`)
}

console.log(`\n  WORK on melee (${live.length}): ${live.join(', ')}`)
console.log(`  INERT on melee (${inert.length}): ${inert.join(', ')}`)
console.log(`\n  The melee branch reads only: ${MELEE_READS.join(', ')}.`)
console.log('  No projectileSpec is built, so every bullet-behaviour mod is dead weight.')

// ── Live fire: prove the inert ones really do nothing, and find the traps ────
const placeNear = (w: World, arch: string, sx: number, sy: number): Entity | undefined => {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0]] as const) {
    const e = spawnNpc(w, arch, sx + dx, sy + dy)
    if (e) return e
  }
  return undefined
}

/** Swing a modded BAT at a dummy and report damage dealt over a fixed window. */
const meleeDamage = (mods: string[], seed: number): number | undefined => {
  const w = createWorld(seed, 1)
  const sp = w.level.spawn
  const p = spawnPlayer(w, 0, sp.x, sp.y)
  if (!p) return undefined
  // Give the player a BAT as the slotted weapon so mods have a home on it.
  p.loadout!.inventory = [{ itemId: 'bat', qty: 1, mods: mods.map((id) => ({ id, stacks: 1 })) }]
  p.combat!.weapon = 'bat'
  const foe = placeNear(w, 'brute', sp.x, sp.y)
  if (!foe || !foe.health) return undefined
  foe.health.hp = 100000 // a pool nothing can clear: measure THROUGHPUT, not TTK
  foe.health.max = 100000
  const before = foe.health.hp
  for (let t = 0; t < 300; t++) {
    const dx = foe.pos.x - p.pos.x, dy = foe.pos.y - p.pos.y
    const len = Math.hypot(dx, dy) || 1
    if (p.health) { p.health.hp = 1_000_000; p.health.max = 1_000_000 }
    // Hold the target in place so every swing is comparable.
    foe.pos.x = sp.x + 1
    foe.pos.y = sp.y
    const cmd: InputCmd = { ...emptyInput(), attack: true, aimX: dx / len, aimY: dy / len }
    tickWorld(w, new Map([[0, cmd]]))
  }
  return before - foe.health.hp
}

const med = (mods: string[]): string => {
  const xs: number[] = []
  for (const s of [11, 22, 33]) { const v = meleeDamage(mods, s); if (v !== undefined) xs.push(v) }
  if (!xs.length) return '   n/a'
  xs.sort((a, b) => a - b)
  return String(xs[Math.floor(xs.length / 2)]).padStart(6)
}

console.log('\n=== LIVE FIRE: damage dealt by a modded BAT over 10s ===')
console.log('(a 100k-hp dummy held in place, so this is throughput, not time-to-kill)\n')
console.log('bat + ...                       damage   reading')
const CASES: [string, string[], string][] = [
  ['(nothing)', [], 'baseline'],
  ['heavy', ['heavy'], 'stat mod — should help'],
  ['overload', ['overload'], 'stat mod — should help'],
  ['incendiary', ['incendiary'], 'element — should help (burn DoT)'],
  ['pierce', ['pierce'], 'INERT — bullet-only'],
  ['bounce', ['bounce'], 'INERT — bullet-only'],
  ['lifesteal', ['lifesteal'], 'INERT — melee never reads it'],
  ['explosive', ['explosive'], 'INERT — bullet-only'],
  ['bulk', ['bulk'], 'TRAP — pellets ignored, x0.8 damage kept'],
]
for (const [label, mods, note] of CASES) {
  console.log(`${label.padEnd(30)} ${med(mods)}   ${note}`)
}
