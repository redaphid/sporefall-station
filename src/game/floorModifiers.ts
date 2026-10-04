// FLOOR MODIFIERS — a per-floor condition orthogonal to the mission template
// (INSPO.md §5, PR #74). A modifier changes what a floor asks of you without a
// new template:
//
//   bogTide   low ground floods on a cycle: bodies in the water wade slowly and
//             come out WET, so an electric arc chains through them.
//   brownout  the lights are failing: every NPC's sight is cut short (stealth
//             gets easier) and the screen goes dark past each player's lamp.
//   hunted    a tracker pack arrives on a timer and follows your scent, so you
//             keep moving.
//
// Determinism: the roll is a pure function of seed+floor on its OWN stream
// (`modifier:<floor>`, a fork of the run seed). It never draws from `w.rng`, so
// layouts, missions, populate and every frozen fixture stay byte-identical.
// This file is the data shape plus pure queries; the per-tick effects live in
// systems/modifierSystem.ts.

import type { Entity } from './entity'
import { STOREY_SIZE, Tile, type Level } from './levelgen/level'
import { hashLabel, mulberry32 } from './rng'
import { storeyOf } from './stairs'
import { SIM_RATE } from './types'
import type { World } from './world'

export type FloorModifierKind = 'bogTide' | 'brownout' | 'hunted'
export const FLOOR_MODIFIER_KINDS: readonly FloorModifierKind[] = ['bogTide', 'brownout', 'hunted']

export interface FloorModifier {
  kind: FloorModifierKind
  /** Tick the floor began. The tide cycle and the first hunt count from it. */
  since: number
  /** hunted: tick the next tracker pack arrives. Absent while one is out. */
  huntAt?: number
  /** hunted: the group id of the tracker pack currently out. */
  packId?: number
  /** hunted: packs sent so far this floor (seeds each arrival's dice). */
  hunts?: number
}

/** Floor 1 teaches the base game, so it is always clean. */
export const MODIFIER_FIRST_FLOOR = 2
/** Half of the floors from 2 on. On every floor a modifier would become the
 * baseline instead of a twist; at one in two a typical run (floors 2-6) meets
 * two or three, and the clean floors between them are the contrast. */
export const MODIFIER_CHANCE = 0.5

const S = SIM_RATE
/** One full tide: dry, then flooded. */
export const TIDE_PERIOD = 25 * S
/** The flooded part of each cycle (its tail), so every floor opens dry. */
export const TIDE_FLOOD = 10 * S
/** Walk speed multiplier while wading in a flooded low tile. */
export const WADE_SPEED = 0.65
/** A floor needs this much low ground for the tide to matter; otherwise the
 * roll picks from the other modifiers. */
export const TIDE_MIN_TILES = 60
/** NPC sight multiplier during a brownout. */
export const BROWNOUT_SIGHT = 0.55
/** First tracker pack this long after the floor starts. */
export const HUNT_FIRST = 30 * S
/** After a tracker pack is wiped out, the next one comes this much later. */
export const HUNT_GAP = 45 * S
/** A hunt that could not land (no one to hunt, nowhere to arrive) retries. */
export const HUNT_RETRY = 5 * S

/** Low ground: streets outside, corridors, vent grates and bog seep inside.
 * Rooms and sidewalks stay dry, so the tide reroutes you through them. */
export const isLowTile = (t: number): boolean => t === Tile.Street || t === Tile.Hall || t === Tile.Grate || t === Tile.Bog

/** Ground-storey low tiles on a level. Lofts never flood. */
export const lowTileCount = (level: Level): number => {
  let n = 0
  const maxX = Math.min(level.w, STOREY_SIZE)
  for (let y = 0; y < level.h; y++) for (let x = 0; x < maxX; x++) if (isLowTile(level.tiles[y * level.w + x])) n++
  return n
}

/** This floor's modifier, or undefined for a clean floor. Pure of seed+floor+level. */
export const rollFloorModifier = (seed: number, floor: number, level: Level): FloorModifierKind | undefined => {
  if (floor < MODIFIER_FIRST_FLOOR) return undefined
  const r = mulberry32(hashLabel(seed >>> 0, `modifier:${floor}`))
  if (!r.chance(MODIFIER_CHANCE)) return undefined
  const options = lowTileCount(level) >= TIDE_MIN_TILES ? FLOOR_MODIFIER_KINDS : FLOOR_MODIFIER_KINDS.filter((k) => k !== 'bogTide')
  return options[r.int(0, options.length - 1)]
}

/** Is the tide in at `tick`? */
export const tideFlooded = (m: Pick<FloorModifier, 'kind' | 'since'> | undefined, tick: number): boolean =>
  m?.kind === 'bogTide' && tick >= m.since && (tick - m.since) % TIDE_PERIOD >= TIDE_PERIOD - TIDE_FLOOD

/** Is this body standing in the flood right now? */
export const inFlood = (w: World, e: Entity): boolean =>
  tideFlooded(w.modifier, w.tick) &&
  storeyOf(e.pos.x) === 0 &&
  isLowTile(w.level.tiles[Math.floor(e.pos.y) * w.level.w + Math.floor(e.pos.x)])

/** Walk-speed multiplier from the floor's modifier (1 unless wading). */
export const wadeMult = (w: World, e: Entity): number => (inFlood(w, e) ? WADE_SPEED : 1)

/** NPC sight multiplier from the floor's modifier. */
export const sightMult = (w: World): number => (w.modifier?.kind === 'brownout' ? BROWNOUT_SIGHT : 1)

/** What the HUD/renderer needs, derived from the modifier and the host tick.
 * Shared by host sessions and net clients so both show the same thing. */
export interface ModifierView {
  kind: FloorModifierKind
  /** bogTide: the tide is in. */
  flooded?: boolean
  /** hunted: whole seconds until the next pack; absent while one is out. */
  huntIn?: number
}

export const modifierView = (m: FloorModifier | undefined, tick: number): ModifierView | undefined => {
  if (!m) return undefined
  if (m.kind === 'bogTide') return { kind: m.kind, flooded: tideFlooded(m, tick) }
  if (m.kind === 'hunted' && m.huntAt !== undefined) return { kind: m.kind, huntIn: Math.max(0, Math.ceil((m.huntAt - tick) / S)) }
  return { kind: m.kind }
}
