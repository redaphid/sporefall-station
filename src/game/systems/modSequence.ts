// Sequenced mod casting: how a weapon fires its mods.
//
// A weapon's mod list is an ordered wand: each cast consumes the next entries,
// so order is the mechanic.
//
// Two kinds of mod:
//   - PAYLOAD: a mod that carries an element (`onHit`). A cast ends on it, and
//     the cast's projectile carries exactly that one element.
//   - MODIFIER: everything else (stat, bullet-behavior and trigger mods). A
//     modifier does not end a cast; it rides on the next payload in sequence.
// A cast walks forward from `castIndex` collecting modifiers until it consumes a
// payload or runs off the end of the list. Running off the end WRAPS the index
// to 0 and, when the cycle has two or more casts, starts the weapon's recharge.
// A one-cast cycle is a plain gun (planPull).
//
// Per-weapon sim state lives on the weapon's ItemStack (`castIndex`,
// `rechargeUntil`) so it is per-entity, serializes with the world, and reaches a
// co-op client inside the InventoryMsg it already receives. Everything here is a
// pure function of (weapon def, mod list, stored index): no RNG, no clock.

import type { WeaponDef } from '../data/items'
import { MODS } from '../data/mods'
import type { Entity, ItemStack, WeaponMod } from '../entity'
import { weaponStack } from './inventory'

/** The weapon's sequence shape, with defaults filled in. */
export interface SequenceShape {
  /** How many leading entries of the mod list are live. Later ones are stowed. */
  slots: number
  /** Consecutive casts one trigger pull performs (melee always 1). */
  castsPerTrigger: number
  /** Ticks the weapon cannot fire after its index wraps. */
  rechargeOnWrap: number
}

export const DEFAULT_SEQUENCE_SHAPE: SequenceShape = { slots: 3, castsPerTrigger: 1, rechargeOnWrap: 20 }

export const sequenceShape = (def: WeaponDef): SequenceShape => ({
  slots: Math.max(1, Math.floor(def.slots ?? DEFAULT_SEQUENCE_SHAPE.slots)),
  castsPerTrigger: def.kind === 'melee' ? 1 : Math.max(1, Math.floor(def.castsPerTrigger ?? DEFAULT_SEQUENCE_SHAPE.castsPerTrigger)),
  rechargeOnWrap: Math.max(0, Math.floor(def.rechargeOnWrap ?? DEFAULT_SEQUENCE_SHAPE.rechargeOnWrap)),
})

/** A payload mod ends a cast and supplies the cast's single element. */
export const isPayloadMod = (id: string): boolean => MODS[id]?.onHit !== undefined

/** The live part of the list: known ids with positive stacks, first `slots` of
 * them. Unknown/empty entries are skipped rather than occupying a slot, the
 * same leniency resolveWeapon applies. Returns ORIGINAL list indices so the UI
 * and the swap input can refer to real positions. */
export const liveEntries = (mods: readonly WeaponMod[] | undefined, slots: number): number[] => {
  const out: number[] = []
  if (!mods) return out
  for (let i = 0; i < mods.length && out.length < slots; i++) {
    const m = mods[i]
    if (MODS[m.id] && m.stacks > 0) out.push(i)
  }
  return out
}

export interface PlannedCast {
  /** The mods this cast resolves with: its modifiers, then its payload if any. */
  mods: WeaponMod[]
  /** Positions in the live window this cast consumed (for the HUD). */
  positions: number[]
  /** The payload that ended the cast, if one did. */
  payload?: WeaponMod
}

export interface CastPlan {
  casts: PlannedCast[]
  /** Window position the next trigger pull starts from. */
  nextIndex: number
  /** The pull ran off the end of the list (index reset to 0, recharge starts). */
  wrapped: boolean
}

/**
 * Plan one trigger pull. `castIndex` is a position in the live window (not a
 * raw list index). A stored index past the end of the window (the window can
 * change under it via pickups or a swap) is treated as already at the end:
 * the pull starts from 0 without charging a recharge, because the player did
 * not fire through anything.
 *
 * Casting stops early at a wrap: the rest of the pull is lost to the recharge.
 */
export const planCasts = (
  mods: readonly WeaponMod[] | undefined,
  shape: SequenceShape,
  castIndex: number,
): CastPlan => {
  const live = liveEntries(mods, shape.slots)
  const n = live.length
  if (n === 0) return { casts: [], nextIndex: 0, wrapped: false }
  let i = Number.isInteger(castIndex) && castIndex >= 0 && castIndex < n ? castIndex : 0
  const casts: PlannedCast[] = []
  let wrapped = false
  for (let c = 0; c < shape.castsPerTrigger && !wrapped; c++) {
    const cast: PlannedCast = { mods: [], positions: [] }
    while (i < n) {
      const m = mods![live[i]]
      cast.mods.push({ id: m.id, stacks: m.stacks })
      cast.positions.push(i)
      i++
      if (isPayloadMod(m.id)) {
        cast.payload = { id: m.id, stacks: m.stacks }
        break
      }
    }
    casts.push(cast)
    if (i >= n) {
      i = 0
      wrapped = true
    }
  }
  return { casts, nextIndex: i, wrapped }
}

/** Casts in one full cycle of the live window, from position 0 to the wrap. */
export const cycleCasts = (mods: readonly WeaponMod[] | undefined, shape: SequenceShape): number =>
  planCasts(mods, { ...shape, castsPerTrigger: shape.slots }, 0).casts.length

/** The next trigger pull, and the shape it fires with. */
export interface PullPlan {
  shape: SequenceShape
  plan: CastPlan
}

/**
 * Plan the next trigger pull of `def` loaded with `mods`. A wand whose whole
 * cycle is one cast (only modifiers, or a single element) is a plain gun: every
 * pull fires that full cast with all its pellets, at the cast's cooldown, and
 * never recharges (#115). The pellet split and the wrap recharge apply only to
 * a cycle of two or more casts.
 */
export const planPull = (def: WeaponDef, mods: readonly WeaponMod[] | undefined, castIndex: number): PullPlan => {
  const shape = sequenceShape(def)
  if (cycleCasts(mods, shape) > 1) return { shape, plan: planCasts(mods, shape, castIndex) }
  const plain = { ...shape, castsPerTrigger: 1, rechargeOnWrap: 0 }
  return { shape: plain, plan: planCasts(mods, plain, 0) }
}

/** Is the weapon stack still recharging at `tick`? */
export const recharging = (stack: ItemStack | undefined, tick: number): boolean =>
  stack?.rechargeUntil !== undefined && stack.rechargeUntil > tick

/** Split `total` pellets over `groups` casts as evenly as possible, front-loaded,
 * never below one pellet per cast. */
export const pelletShares = (total: number, groups: number): number[] => {
  const g = Math.max(1, groups)
  const t = Math.max(g, Math.floor(total))
  const base = Math.floor(t / g)
  const extra = t % g
  return Array.from({ length: g }, (_, i) => base + (i < extra ? 1 : 0))
}

/** Pack a reorder request (swap list entries `a` and `b`) into the InputCmd scalar. */
export const packModSwap = (a: number, b: number): number => ((a & 0xff) << 8) | (b & 0xff)
export const unpackModSwap = (v: number): { a: number; b: number } => ({ a: (v >> 8) & 0xff, b: v & 0xff })

/**
 * Apply a reorder request to the entity's wielded weapon: swap two entries of
 * its mod list (raw list indices, so a stowed mod can be swapped into the live
 * window). Invalid requests are ignored.
 *
 * Reordering does NOT reset `castIndex` or the recharge. The index is a
 * position in the window, so after a swap the next cast fires whatever now
 * sits at that position. Resetting it would make reordering a free reload.
 */
export const applyModSwap = (e: Entity, packed: number): boolean => {
  const stack = weaponStack(e)
  const mods = stack?.mods
  if (!mods || !Number.isInteger(packed) || packed < 0) return false
  const { a, b } = unpackModSwap(packed)
  if (a === b || a >= mods.length || b >= mods.length) return false
  const tmp = mods[a]
  mods[a] = mods[b]
  mods[b] = tmp
  return true
}
