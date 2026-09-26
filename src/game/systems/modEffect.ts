// What a mod will actually DO on a given weapon, derived from what the fire path
// executes rather than from the mod's own description. The UI reads this so a
// mod the sim never runs (pierce on a sledgehammer, a stowed mod, choke on a
// single-pellet pistol) reads as inert instead of as a working buff.
//
// `modEffect.truth.test.ts` fires every mod on every weapon through the real
// `fireWeapon` and fails if this verdict and the sim's behaviour disagree.

import type { StatusApply, WeaponDef } from '../data/items'
import { MODS, stackMod, type BulletBehavior, type ResolvedTrigger } from '../data/mods'
import type { WeaponMod } from '../entity'
import { PLAYER_MELEE_MULT } from '../player'
import { resolveWeapon, type CarriedElements, type ResolvedWeapon } from './resolveWeapon'
import { pelletShares, planCasts, planPull, type SequenceShape } from './modSequence'

/** The fields of a resolved weapon that `fireWeapon` reads. Both kinds read
 * damage, cooldown, element and triggers. Only a swing reads knockback: a
 * bullet always shoves by a fixed amount (projectiles.ts). Only a gun reads the
 * bullet fields, and spread only when it fires more than one pellet (a lone
 * pellet's fan offset is always 0). An element that loses the round can still
 * ride its shards or blast (`carries`), so it is live there. */
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
  carries?: CarriedElements
}

/** The damage a swing deals before the target's defences: players hit harder
 * with melee. fireWeapon calls this too, so the panel cannot drift from it. */
export const meleeDamage = (resolvedDamage: number, byPlayer: boolean): number =>
  Math.round(resolvedDamage * (byPlayer ? PLAYER_MELEE_MULT : 1))

const shotFrom = (weapon: WeaponDef, rw: ResolvedWeapon, byPlayer: boolean): ExecutedShot => {
  const shot: ExecutedShot = {
    damage: weapon.kind === 'melee' ? meleeDamage(rw.damage, byPlayer) : rw.damage,
    cooldownTicks: rw.cooldownTicks,
    onHit: rw.onHit,
    triggers: rw.triggers,
  }
  if (weapon.kind === 'melee') return { ...shot, knockback: rw.knockback }
  shot.pellets = rw.pellets
  if (rw.pellets > 1) shot.spread = rw.spread
  shot.projectileSpeed = rw.projectileSpeed
  shot.behavior = rw.behavior
  shot.carries = rw.carries
  return shot
}

/** One cast of `weapon` with `mods`, fired by a player unless `byPlayer` is false. */
export const executedShot = (weapon: WeaponDef, mods: readonly WeaponMod[], byPlayer = true): ExecutedShot =>
  shotFrom(weapon, resolveWeapon(weapon, mods), byPlayer)

/** Everything one trigger pull fires, as a player. */
export interface ExecutedPull {
  casts: ExecutedShot[]
  cooldownTicks: number
  /** Ranged only: pellets across every cast, and the angle between the outer two. */
  pellets?: number
  fan?: number
}

/**
 * The pull a player fires next. Mirrors fireWeapon (combat.ts): it plans the
 * pull from `castIndex`, splits the pellets between its casts, fans them across
 * one spread, and takes the slowest cast's cooldown, raised to the recharge
 * when the pull wraps a cycle of two or more casts.
 * `src/ui/loadoutTruth.test.ts` fires the real weapon and holds the panel to it.
 */
export const executedPull = (weapon: WeaponDef, mods: readonly WeaponMod[], castIndex = 0): ExecutedPull => {
  const { shape, plan } = planPull(weapon, mods, castIndex)
  // Every entry unknown or empty: the sim fires the bare weapon.
  const castMods: WeaponMod[][] = plan.casts.length > 0 ? plan.casts.map((c) => c.mods) : [[]]
  const recharge = (cd: number): number =>
    plan.wrapped && shape.rechargeOnWrap > 0 ? Math.max(cd, shape.rechargeOnWrap) : cd
  if (weapon.kind === 'melee') {
    const shot = executedShot(weapon, castMods[0])
    return { casts: [shot], cooldownTicks: recharge(shot.cooldownTicks) }
  }
  const shares = pelletShares(weapon.pellets ?? 1, shape.castsPerTrigger)
  const rws = castMods.map((m, g) => resolveWeapon({ ...weapon, pellets: shares[g] }, m))
  const total = rws.reduce((n, rw) => n + rw.pellets, 0)
  const offsets: number[] = []
  for (const rw of rws) for (let j = 0; j < rw.pellets; j++) offsets.push(total > 1 ? (offsets.length / (total - 1) - 0.5) * rw.spread : 0)
  const casts = rws.map((rw) => shotFrom(weapon, rw, true))
  return {
    casts,
    cooldownTicks: recharge(Math.max(1, ...casts.map((c) => c.cooldownTicks))),
    pellets: total,
    fan: Math.max(...offsets) - Math.min(...offsets),
  }
}

/** `live`: the mod changes what fires. `inert`: it changes nothing. `penalty`:
 * only its downside executes. Reasons are five words or fewer. */
export type ModVerdict =
  | { kind: 'live' }
  | { kind: 'inert'; reason: string }
  | { kind: 'penalty'; reason: string }

/** One trigger pull: its casts, each with the pellets it fires, and whether the
 * pull ran off the end of the wand. */
interface CyclePull {
  casts: { mods: WeaponMod[]; pellets: number }[]
  wrapped: boolean
}

/** Every pull of one full cycle from index 0: the order the fire path
 * walks the wand in steady state. */
const pullCycle = (weapon: WeaponDef, mods: readonly WeaponMod[]): { shape: SequenceShape; pulls: CyclePull[] } => {
  const { shape } = planPull(weapon, mods, 0)
  const shares = pelletShares(weapon.pellets ?? 1, shape.castsPerTrigger)
  const pulls: CyclePull[] = []
  let index = 0
  for (let pull = 0; pull <= shape.slots; pull++) {
    const plan = planCasts(mods, shape, index)
    if (plan.casts.length === 0) break
    pulls.push({ casts: plan.casts.map((c, g) => ({ mods: c.mods, pellets: shares[g] })), wrapped: plan.wrapped })
    if (plan.wrapped) break
    index = plan.nextIndex
  }
  return { shape, pulls }
}

/** The shot a mod rides in, with and without it. A pull's cooldown is the
 * slowest of its casts, raised to the recharge when the pull wraps (as in
 * fireWeapon), so a mod that only speeds up a wrapping cast changes nothing.
 * Undefined when the mod is stowed: no cast of the cycle carries it. */
const castShots = (weapon: WeaponDef, mods: readonly WeaponMod[], modId: string): [ExecutedShot, ExecutedShot] | undefined => {
  const hasIt = (c: { mods: WeaponMod[] }): boolean => c.mods.some((m) => m.id === modId)
  const { shape, pulls } = pullCycle(weapon, mods)
  const pull = pulls.find((p) => p.casts.some(hasIt))
  if (!pull) return undefined
  const shot = (dropIt: boolean): ExecutedShot => {
    const shots = pull.casts.map((c) =>
      executedShot({ ...weapon, pellets: c.pellets }, dropIt ? c.mods.filter((m) => m.id !== modId) : c.mods),
    )
    let cooldown = Math.max(1, ...shots.map((s) => s.cooldownTicks))
    if (pull.wrapped) cooldown = Math.max(cooldown, shape.rechargeOnWrap)
    return { ...shots[pull.casts.findIndex(hasIt)], cooldownTicks: cooldown }
  }
  return [shot(false), shot(true)]
}

/** A mod whose only effect is a faster cast that the wrap recharge then
 * outlasts. */
const rechargeHidesIt = (weapon: WeaponDef, mods: readonly WeaponMod[], modId: string): boolean => {
  const cast = pullCycle(weapon, mods).pulls.flatMap((p) => p.casts).find((c) => c.mods.some((m) => m.id === modId))
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

/** The verdict a mod past the weapon's live window gets: it never fires. */
export const STOWED_VERDICT = { kind: 'inert', reason: 'stowed: swap it in' } as const satisfies ModVerdict

/**
 * The verdict for mod `modId` as installed in `mods` on `weapon`, judged on the
 * one cast it rides in. A mod past the weapon's live window is stowed and never
 * fires. A mod missing from `mods` is judged as if picked up: placed where a
 * pick lands, which decides whether it is live or stowed.
 */
export const modVerdict = (weapon: WeaponDef, mods: readonly WeaponMod[], modId: string): ModVerdict => {
  if (!MODS[modId]) return { kind: 'inert', reason: 'unknown mod' }
  const installed = mods.some((m) => m.id === modId && m.stacks > 0) ? mods : stackMod(mods.map((m) => ({ ...m })), modId, 1)
  const shots = castShots(weapon, installed, modId)
  if (!shots) return { ...STOWED_VERDICT }
  const [withIt, without] = shots
  if (same(withIt, without)) {
    if (rechargeHidesIt(weapon, installed, modId)) return { kind: 'inert', reason: 'recharge hides it' }
    return { kind: 'inert', reason: weapon.kind === 'melee' ? 'no effect on melee' : 'no effect on this gun' }
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

