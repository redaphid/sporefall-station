// What a mod will actually DO on a given weapon, derived from what the fire path
// executes rather than from the mod's own description. The UI reads this so a
// mod the sim never runs (pierce on a sledgehammer, the losing element of two,
// choke on a single-pellet pistol) reads as inert instead of as a working buff.
//
// `modEffect.truth.test.ts` fires every mod on every weapon through the real
// `fireWeapon` and fails if this verdict and the sim's behaviour disagree.

import type { StatusApply, WeaponDef } from '../data/items'
import { MODS, type BulletBehavior, type ResolvedTrigger } from '../data/mods'
import type { WeaponMod } from '../entity'
import { resolveWeapon } from './resolveWeapon'
import { pelletShares, planCasts, sequenceShape } from './modSequence'

/** The fields of a resolved weapon that `fireWeapon` reads. Both kinds read
 * damage, cooldown, element and triggers. Only a swing reads knockback: a
 * bullet always shoves by a fixed amount (projectiles.ts). Only a gun reads the
 * bullet fields, and spread only when it fires more than one pellet (a lone
 * pellet's fan offset is always 0). */
export interface ExecutedShot {
  damage: number
  cooldownTicks: number
  knockback?: number
  onHit?: StatusApply
  triggers: ResolvedTrigger[]
  pellets?: number
  spread?: number
  projectileSpeed?: number
  behavior?: BulletBehavior
}

export const executedShot = (weapon: WeaponDef, mods: readonly WeaponMod[]): ExecutedShot => {
  const rw = resolveWeapon(weapon, mods)
  const shot: ExecutedShot = {
    damage: rw.damage,
    cooldownTicks: rw.cooldownTicks,
    onHit: rw.onHit,
    triggers: rw.triggers,
  }
  if (weapon.kind === 'melee') return { ...shot, knockback: rw.knockback }
  shot.pellets = rw.pellets
  if (rw.pellets > 1) shot.spread = rw.spread
  shot.projectileSpeed = rw.projectileSpeed
  shot.behavior = rw.behavior
  return shot
}

/** `live`: the mod changes what fires. `inert`: it changes nothing. `penalty`:
 * only its downside executes. Reasons are five words or fewer. */
export type ModVerdict =
  | { kind: 'live' }
  | { kind: 'inert'; reason: string }
  | { kind: 'penalty'; reason: string }

/** One trigger pull of a sequenced weapon: its casts, each with the pellets it
 * fires, and whether the pull ran off the end of the wand. */
interface CyclePull {
  casts: { mods: WeaponMod[]; pellets: number }[]
  wrapped: boolean
}

/** Every pull of one full sequenced cycle from index 0: the order the fire path
 * walks the wand in steady state. */
const pullCycle = (weapon: WeaponDef, mods: readonly WeaponMod[]): CyclePull[] => {
  const shape = sequenceShape(weapon)
  const shares = pelletShares(weapon.pellets ?? 1, shape.castsPerTrigger)
  const out: CyclePull[] = []
  let index = 0
  for (let pull = 0; pull <= shape.slots; pull++) {
    const plan = planCasts(mods, shape, index)
    if (plan.casts.length === 0) break
    out.push({ casts: plan.casts.map((c, g) => ({ mods: c.mods, pellets: shares[g] })), wrapped: plan.wrapped })
    if (plan.wrapped) break
    index = plan.nextIndex
  }
  return out
}

/** The shot a sequenced mod rides in, with and without it. A pull's cooldown is
 * the slowest of its casts, raised to the recharge when the pull wraps (as in
 * fireSequenced), so a mod that only speeds up a wrapping cast changes nothing. */
const sequencedShots = (weapon: WeaponDef, mods: readonly WeaponMod[], modId: string): [ExecutedShot, ExecutedShot] | undefined => {
  const hasIt = (c: { mods: WeaponMod[] }): boolean => c.mods.some((m) => m.id === modId)
  const pull = pullCycle(weapon, mods).find((p) => p.casts.some(hasIt))
  if (!pull) return undefined
  const shot = (dropIt: boolean): ExecutedShot => {
    const shots = pull.casts.map((c) =>
      executedShot({ ...weapon, pellets: c.pellets }, dropIt ? c.mods.filter((m) => m.id !== modId) : c.mods),
    )
    let cooldown = Math.max(1, ...shots.map((s) => s.cooldownTicks))
    if (pull.wrapped) cooldown = Math.max(cooldown, sequenceShape(weapon).rechargeOnWrap)
    return { ...shots[pull.casts.findIndex(hasIt)], cooldownTicks: cooldown }
  }
  return [shot(false), shot(true)]
}

/** A sequenced mod whose only effect is a faster cast that the wrap recharge
 * then outlasts. */
const rechargeHidesIt = (weapon: WeaponDef, mods: readonly WeaponMod[], modId: string): boolean => {
  const cast = pullCycle(weapon, mods).flatMap((p) => p.casts).find((c) => c.mods.some((m) => m.id === modId))
  const rate = (list: WeaponMod[]): number => executedShot(weapon, list).cooldownTicks
  return cast !== undefined && rate(cast.mods) !== rate(cast.mods.filter((m) => m.id !== modId))
}

// Numeric fields where a larger value is better for the shooter.
const HIGHER_BETTER: Record<string, boolean> = {
  damage: true, cooldownTicks: false, knockback: true, pellets: true, spread: false, projectileSpeed: true,
}
const LABEL: Record<string, string> = {
  damage: 'damage', cooldownTicks: 'fire rate', knockback: 'knockback', pellets: 'pellets', spread: 'accuracy', projectileSpeed: 'bullet speed',
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * The verdict for mod `modId` as installed in `mods` on `weapon`. In sequenced
 * mode it is judged on the one cast it rides in; a mod past the weapon's live
 * window is stowed and never fires. A mod missing from `mods` is judged as if a
 * stack of it were installed.
 */
export const modVerdict = (
  weapon: WeaponDef,
  mods: readonly WeaponMod[],
  modId: string,
  sequenced = false,
): ModVerdict => {
  if (!MODS[modId]) return { kind: 'inert', reason: 'unknown mod' }
  const installed = mods.some((m) => m.id === modId && m.stacks > 0) ? mods : [...mods, { id: modId, stacks: 1 }]
  const shots = sequenced
    ? sequencedShots(weapon, installed, modId)
    : [executedShot(weapon, installed), executedShot(weapon, installed.filter((m) => m.id !== modId))]
  if (!shots) return { kind: 'inert', reason: 'stowed: swap it in' }
  const [withIt, without] = shots
  if (same(withIt, without)) {
    if (sequenced && rechargeHidesIt(weapon, installed, modId)) return { kind: 'inert', reason: 'recharge hides it' }
    return { kind: 'inert', reason: inertReason(weapon, withIt, modId) }
  }

  const worse: string[] = []
  let anyBetterOrOther = false
  for (const k of Object.keys(withIt) as (keyof ExecutedShot)[]) {
    if (same(withIt[k], without[k])) continue
    const a = withIt[k]
    const b = without[k]
    if (k in HIGHER_BETTER && typeof a === 'number' && typeof b === 'number' && (a > b) !== HIGHER_BETTER[k]) worse.push(LABEL[k])
    else anyBetterOrOther = true
  }
  if (anyBetterOrOther) return { kind: 'live' }
  return { kind: 'penalty', reason: worse.length === 1 ? `only lowers ${worse[0]}` : 'only makes it worse' }
}

const inertReason = (weapon: WeaponDef, shot: ExecutedShot, modId: string): string => {
  if (MODS[modId].onHit) {
    const winner = Object.values(MODS).find((d) => d.id !== modId && d.onHit && same(d.onHit, shot.onHit))
    if (winner) return `${winner.name} overrides it`
  }
  return weapon.kind === 'melee' ? 'no effect on melee' : 'no effect on this gun'
}
