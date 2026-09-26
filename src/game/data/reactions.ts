// Primer/Striker prototype (World.primerStriker, design A): the substance and
// verb grammar. Pure data; systems/reactions.ts applies it.
//
// The Primer coats bodies with a SUBSTANCE. The Striker lands a VERB, named by
// the element its round carries. A verb meeting the right substance reacts;
// anything else just happens (the plain element lands, the substance stays).
//
//   verb \ on   | soak (wet)        | oil               | rime              | magnet
//   ------------+-------------------+-------------------+-------------------+----------------
//   spark       | ARC floods wet    | IGNITE: wildfire  | plain             | HOP to magnets
//   flame       | STEAM: no burn,   | WILDFIRE floods   | MELT: rime → wet  | HOP to magnets
//               | target blinded    | oiled bodies      |                   |
//   frost       | FLASH FREEZE      | FIZZLE: nothing,  | DEEP FREEZE       | HOP to magnets
//               | floods wet        | oil stays         | (ignores the DR)  |
//   impact      | plain             | plain             | CRACK: ignores    | plain
//               |                   |                   | armour, x2        |
//
// Every reaction consumes the substance it used, so a prime is a one-shot setup.

import type { StatusApply } from './items'

export type SubstanceId = 'soak' | 'oil' | 'rime' | 'magnet'
export type VerbId = 'impact' | 'spark' | 'flame' | 'frost' | 'wash'

export interface SubstanceDef {
  id: SubstanceId
  /** The `fx` status key the coat lives in. `wet` is the existing element. */
  status: string
  ticks: number
  /** What the playtest `look` and the cast plan call it. */
  label: string
}

export const SUBSTANCES: Record<SubstanceId, SubstanceDef> = {
  soak: { id: 'soak', status: 'wet', ticks: 150, label: 'SOAK' },
  oil: { id: 'oil', status: 'oiled', ticks: 300, label: 'OIL' },
  rime: { id: 'rime', status: 'rimed', ticks: 180, label: 'RIME' },
  magnet: { id: 'magnet', status: 'magnetised', ticks: 150, label: 'MAGNET' },
}

/** The verb a Striker round lands, read off the element it carries. */
const VERB_BY_STATUS: Record<string, VerbId> = {
  electrified: 'spark',
  burning: 'flame',
  frozen: 'frost',
  wet: 'wash',
}

export const verbOf = (onHit: StatusApply | undefined): VerbId => (onHit ? (VERB_BY_STATUS[onHit.status] ?? 'impact') : 'impact')

export const VERB_LABEL: Record<VerbId, string> = {
  impact: 'IMPACT',
  spark: 'SPARK',
  flame: 'FLAME',
  frost: 'FROST',
  wash: 'WASH',
}

/** How close two coated bodies must be for a flood to jump between them. The
 * same number as the existing wet+shock chain (systems/interactions.ts). */
export const CHAIN_RADIUS = 1.6
/** Most bodies one flood reaches, and the strength kept per hop past the first. */
export const FLOOD_CAP = 6
export const FLOOD_FALLOFF = 0.85
/** Arc damage per wet body, before `resist.electrified`. */
export const ARC_DAMAGE = 30
/** The extra jolt every Spark round lands on what it hits, before `resist.electrified`. */
export const SPARK_ZAP = 6
/** Burst damage per oiled body when a wildfire catches it, before `resist.burning`. */
export const WILDFIRE_BURST = 12
export const BURN_TICKS = 240
export const FREEZE_TICKS = 120
/** Steam blinds an NPC this long: it drops its target and cannot fight. */
export const STEAM_TICKS = 90
/** A crack is this many times the blow, with physical armour ignored. */
export const CRACK_MULT = 2
/** Rimed bodies walk at this fraction of their speed. */
export const RIME_SLOW = 0.6
/** A magnet hop reaches every other magnetised body this close, at this strength. */
export const MAGNET_HOP_RADIUS = 4
export const MAGNET_HOP_FRAC = 0.6
/** Per-tick pull toward the centre of the other magnetised bodies in reach
 * (tiles/s of impulse; against movement friction it settles near 2 tiles/s). */
export const MAGNET_PULL = 1.4
export const MAGNET_REACH = 8
/** A body stops being pulled once this close to that centre. */
export const MAGNET_REST = 0.9
/** The Lobber glob's own splash radius, before `explosive` widens it. */
export const LOBBER_SPLASH = 0.9
export const SPLASH_CAP = 4
/** The dropper cannot re-grab an ejected cartridge for this many ticks. */
export const EJECT_NOGRAB_TICKS = 45
