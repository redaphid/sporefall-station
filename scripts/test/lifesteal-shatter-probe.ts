// Does lifesteal pay the same on a SHATTER as on a plain hit?
//
// `applyDamage` now returns the damage actually applied, and lifesteal pays off
// that. A shatter is the awkward case: it is an execute, so "damage applied" is
// ambiguous between the blow's own damage and the whole hp pool it wiped.
//
// The rule implemented: damage DEALT, not lethality GRANTED. The bullet delivers
// its ordinary (resisted) damage; the ice kills separately; lifesteal is paid for
// the bullet only. This probe checks that against the behaviour that shipped.
//
//   npx tsx scripts/test/lifesteal-shatter-probe.ts

import { MODS } from '../../src/game/data/mods'
import { WEAPONS } from '../../src/game/data/items'
import { makeEntity, type Entity } from '../../src/game/entity'
import { applyDamage } from '../../src/game/systems/combat'
import { addStatus } from '../../src/game/systems/statusFx'
import { addEntity, createWorld, type World } from '../../src/game/world'

/** hyperbolic() from resolveWeapon — the accumulation lifesteal actually uses. */
const hyperbolic = (perStack: number, stacks: number): number => 1 - 1 / (1 + perStack * stacks)
const FRAC = hyperbolic(MODS.lifesteal.behavior!.lifestealFrac!, 1)
const BULLET = WEAPONS.pistol.damage

const target = (w: World, hp: number, resist?: number): Entity => {
  const e = addEntity(w, makeEntity('npc', 'civilian', 20, 20))
  e.health = { hp, max: hp, iframes: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  if (resist !== undefined) e.resist = { physical: resist }
  return e
}

console.log(`pistol ${BULLET} dmg, lifesteal 1 stack -> frac ${FRAC.toFixed(4)}`)
console.log(`shipped behaviour paid bullet x frac = ${(BULLET * FRAC).toFixed(2)} hp on EVERY event\n`)
console.log('event                         hp pool  resist   dealt   healed   vs shipped')

const row = (label: string, hp: number, resist: number, frozen: boolean): void => {
  const w = createWorld(1, 1)
  const e = target(w, hp, resist)
  if (frozen) addStatus(w, e, 'frozen', 120)
  const dealt = applyDamage(w, e, BULLET, 0, 0, 0, 99)
  const healed = dealt === null ? 0 : dealt * FRAC
  const shipped = BULLET * FRAC
  const delta = healed === shipped ? 'identical' : `${healed > shipped ? '+' : ''}${(healed - shipped).toFixed(2)}`
  console.log(
    `${label.padEnd(28)} ${String(hp).padStart(6)}  ${String(resist).padStart(6)}  ${String(dealt).padStart(6)}   ${healed.toFixed(2).padStart(6)}   ${delta}`,
  )
}

row('plain hit', 320, 1, false)
row('SHATTER (frozen)', 320, 1, true)
row('SHATTER on a 40hp thug', 40, 1, true)
row('plain hit, armoured', 320, 0.35, false)
row('SHATTER, armoured', 320, 0.35, true)

console.log('\nThe two things this has to prove:')
console.log('  1. a shatter pays the SAME as a plain hit — no execute amplification,')
console.log('     and no silent zero that punishes frost + lifesteal.')
console.log('  2. the payout is independent of the victim HP POOL: a 320hp boss and a')
console.log('     40hp thug pay identically, so no lifebar can ever be harvested.')
