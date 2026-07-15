export const SIM_RATE = 30
export const SIM_DT = 1 / SIM_RATE
export const LEVEL_W = 64
export const LEVEL_H = 64

export type EntityId = number

export interface Vec2 {
  x: number
  y: number
}

export interface InputCmd {
  seq: number
  moveX: number // -1..1
  moveY: number // -1..1
  attack: boolean
  interact: boolean
  special: boolean
  aimX: number
  aimY: number
  /** Hotbar slot to equip this tick, or -1 for none. */
  hotbar: number
  /** Throw the active/nearest throwable this tick. */
  throwItem: boolean
  /** Dodge-roll this tick (edge-triggered): a burst + i-frames in the move dir. */
  roll: boolean
}

export const emptyInput = (): InputCmd => ({
  seq: 0,
  moveX: 0,
  moveY: 0,
  attack: false,
  interact: false,
  special: false,
  aimX: 1,
  aimY: 0,
  hotbar: -1,
  throwItem: false,
  roll: false,
})

/** The visual kinds an annotation can take. `label`/`pin` mark a point or entity;
 * `arrow`/`circle` are free shapes; `text` is a screen-space banner. */
export type AnnotationKind = 'text' | 'label' | 'pin' | 'arrow' | 'circle'

/**
 * Inert presentation data drawn OVER the world by the render overlay — never read
 * or mutated by any sim system, so determinism is untouched. It rides along in
 * world state (serializes/replays) so an agent (or a tutorial, or a game event)
 * can point things out to the player.
 *
 * The headline, most ergonomic form is ENTITY-ANCHORED: give a `targetId` and let
 * the engine position the mark over that entity's LIVE sprite each frame (no x/y).
 * Free-floating `x`/`y` marks exist for points with no entity. `ttlTick` (an
 * ABSOLUTE tick) auto-expires the mark once `w.tick` passes it.
 */
export interface Annotation {
  id: number | string
  kind: AnnotationKind
  text?: string
  /** Free-floating world (label/pin/arrow/circle) or screen (text banner) x. */
  x?: number
  y?: number
  /** Entity to anchor to — the engine reads its live pos and places the mark. */
  targetId?: EntityId
  /** For `arrow`: the world point it points FROM (defaults near the target/point). */
  x2?: number
  y2?: number
  /** For `circle`: world radius in tiles (default 1). */
  radius?: number
  /** CSS colour string; the overlay picks a default when absent. */
  color?: string
  /** Absolute tick at/after which the overlay stops drawing it. */
  ttlTick?: number
}

export type SimEvent =
  | { type: 'hit'; x: number; y: number; targetId: EntityId; amount: number }
  | { type: 'death'; x: number; y: number; entityId: EntityId }
  | { type: 'doorToggle'; entityId: EntityId; open: boolean }
  | { type: 'pickup'; entityId: EntityId; byId: EntityId; itemId: string }
  /** A world weapon-mod pickup was grabbed: `modId` applied to `byId`'s equipped
   * `weapon`. `maxed` = the mod was already at its stack cap (grab was a no-op). */
  | { type: 'modPickup'; entityId: EntityId; byId: EntityId; modId: string; weapon: string; maxed: boolean }
  | { type: 'explosion'; x: number; y: number; radius: number }
  | { type: 'shatter'; x: number; y: number; entityId: EntityId }
  | { type: 'shock'; x: number; y: number; targetId: EntityId }
  | { type: 'use'; entityId: EntityId; byId: EntityId }
  | { type: 'missionComplete'; description: string }
  | { type: 'floorChange'; floor: number }
  | { type: 'noise'; x: number; y: number }
  | { type: 'runOver'; floor: number }
  | { type: 'roll'; x: number; y: number; entityId: EntityId }
