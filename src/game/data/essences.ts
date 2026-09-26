// Essence bubbles (prototype C, docs: loadout design C). Every mod is an
// ESSENCE of one HUE FAMILY. A diver can vent a mod out of the gun's rack and
// leave it hanging in the air as a planted bubble: bullets that fly through it
// pick up its essence (a LENS), and an enemy that walks into it bursts it (a
// MINE). This file is pure data: which family each mod is in, and what a
// family's bubble does when an enemy bursts it.
//
// Only the three element families have a burst in this prototype. A bubble of
// any other family is a lens only: enemies walk through it.

import { MODS } from './mods'

export type HueFamily = 'storm' | 'cold' | 'flame' | 'mirror' | 'flight' | 'weight'

/** What a burst does to the bodies around the bubble. */
export type BurstVerb = 'shock' | 'freeze' | 'ignite'

export interface HueDef {
  family: HueFamily
  /** Render tint for the bubble. Inert to the sim. */
  color: number
  /** Absent: this family is a lens only, never a mine. */
  burst?: BurstVerb
}

export const HUES: Readonly<Record<HueFamily, HueDef>> = {
  storm: { family: 'storm', color: 0xa06cff, burst: 'shock' },
  cold: { family: 'cold', color: 0x9fdcff, burst: 'freeze' },
  flame: { family: 'flame', color: 0xff8a3d, burst: 'ignite' },
  mirror: { family: 'mirror', color: 0xd8dde6 },
  flight: { family: 'flight', color: 0xd9b25a },
  weight: { family: 'weight', color: 0xa0522d },
}

/** Every mod id belongs to exactly one family. A test asserts total coverage
 * over MODS, so a new mod without a family fails CI rather than falling through. */
export const MOD_FAMILY: Readonly<Record<string, HueFamily>> = {
  shock: 'storm',
  frost: 'cold',
  incendiary: 'flame',
  split: 'mirror',
  splinterShot: 'mirror',
  bulk: 'mirror',
  pierce: 'flight',
  bounce: 'flight',
  homing: 'flight',
  velocity: 'flight',
  choke: 'flight',
  heavy: 'weight',
  overload: 'weight',
  glassCannon: 'weight',
  rapid: 'weight',
  explosive: 'weight',
  detonator: 'weight',
  lifesteal: 'weight',
}

export const familyOf = (modId: string): HueFamily | undefined => MOD_FAMILY[modId]

/** The burst a bubble of `modId` sets off, if its family has one. */
export const burstOf = (modId: string): BurstVerb | undefined => {
  const f = MOD_FAMILY[modId]
  return f ? HUES[f].burst : undefined
}

/** A planted bubble lives this long if nothing spends it (20 s). */
export const BUBBLE_TTL_TICKS = 600
/** Lens charges: 3 + 3 per stack, at most 9. */
export const lensCharges = (stacks: number): number => Math.min(9, 3 + 3 * Math.max(1, Math.floor(stacks)))
/** A diver may have this many planted bubbles at once; a third pops the oldest. */
export const MAX_PLANTED_PER_DIVER = 2
/** Bubble body radius (tiles): what a bullet must cross and a body must touch. */
export const BUBBLE_RADIUS = 0.45
/** Burst radius (tiles) around the bubble. */
export const BURST_RADIUS = 1.5
/** How far (tiles, centre to centre) a diver can reach to catch a bubble with interact. */
export const CATCH_RANGE = 1.3

/** Is `modId` an element payload (an essence that carries a status)? */
export const isElementEssence = (modId: string): boolean => MODS[modId]?.onHit !== undefined
