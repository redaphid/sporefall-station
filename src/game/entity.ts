import type { EntityId, Vec2 } from './types'

export type EntityKind = 'player' | 'npc' | 'projectile' | 'pickup' | 'door' | 'interactable' | 'fire'

/** One active status/element effect: the absolute tick at (or before) which it
 * expires, plus who applied it. Keyed by effect kind on `Entity.fx`. Mirrors
 * brain's `fx` convention — absolute-tick expiry keeps it snapshot-safe. */
export interface StatusEntry {
  until: number
  source?: EntityId
}

export type Fx = Record<string, StatusEntry>

export type AiMode = 'idle' | 'wander' | 'patrol' | 'aggro' | 'flee' | 'sleep'
export type Faction = 'civ' | 'cop' | 'gang' | 'neutral'

/** A disposition band, derived from numeric hate by `determineRel`. */
export type RelStatus = 'Friendly' | 'Neutral' | 'Annoyed' | 'Hostile'

/** One agent's view of another: raw hate and the band it derives. */
export interface RelEntry {
  hate: number
  code: RelStatus
}

export interface AiState {
  mode: AiMode
  faction: Faction
  home: Vec2
  targetId?: EntityId
  waypoint?: Vec2
  /** Next tick this NPC runs its full think step. */
  thinkAt: number
  sightRange: number
  lastKnownTargetPos?: Vec2
  /** Per-other-entity disposition, keyed by that entity's id. Absent until this
   * NPC has an opinion; the initial stance is derived from faction on the fly. */
  rel?: Record<EntityId, RelEntry>
  /** Holds position instead of idle-wandering until it spots a target. */
  guard?: boolean
  /** The goal chosen by the last arbitration (battle/flee/pursue/investigate/
   * wander) — drives `mode`, exposed for debugging and the e2e. */
  goal?: string
}

/** One applied weapon modifier: a registry id (`data/mods.ts`) plus a
 * deterministic stack count. Pure JSON — no functions/closures — so a modded
 * loadout serializes and round-trips byte-for-byte like any other component.
 * ROUNDS-style: the same card can be picked (stacked) multiple times. */
export interface WeaponMod {
  id: string
  stacks: number
}

export interface ItemStack {
  itemId: string
  qty: number
  /** Present only on a modded weapon; absent = vanilla, so every pre-existing
   * fixture/snapshot serializes byte-for-byte unchanged (same optional-field
   * discipline as `annotations`). Resolved by `resolveWeapon` at the fire site. */
  mods?: WeaponMod[]
}

export interface Entity {
  id: EntityId
  kind: EntityKind
  /** Key into data/ definitions: 'thug', 'cop', 'player', 'medkit', 'door.wood', ... */
  archetype: string
  pos: Vec2
  /** Position at the previous tick — used for render interpolation. */
  prevPos: Vec2
  /** Knockback/impulse velocity (tiles/sec), decays with friction. */
  vel: Vec2
  /** Desired movement direction (unit vector), set by input or AI. */
  intent: Vec2
  /** Walk speed in tiles/sec. */
  speed: number
  radius: number
  facing: number // radians

  health?: { hp: number; max: number; iframes: number }
  combat?: { weapon: string; cooldown: number }
  ai?: AiState
  playerCtl?: {
    playerId: number
    abilityCooldown: number
    /** Slot-based inventory; each stack's qty doubles as ammo/durability/count. */
    inventory: ItemStack[]
    /** Equipped/hotbar slot index into `inventory`; -1 = bare fists. */
    activeSlot: number
    cash: number
    crimeUntilTick: number
    downed?: { bleedTicks: number; reviveProgress: number }
    /** Timed action in progress (lockpicking). Moving cancels it. */
    channel?: { kind: 'lockpick'; targetId: EntityId; ticksLeft: number }
    /** Active dodge-roll (Enter-the-Gungeon style). Absent = not rolling and off
     * cooldown; all fields are ABSOLUTE ticks / a unit direction, so it serializes
     * and replays byte-for-byte like `hitFlashUntil`. `untilTick` bounds the i-frame
     * + speed-burst window; `cooldownUntilTick` gates the next roll (no chaining);
     * `dirX/dirY` is the frozen roll heading (move dir, or facing when stationary). */
    roll?: { untilTick: number; cooldownUntilTick: number; dirX: number; dirY: number }
  }
  projectile?: {
    ownerId: EntityId
    damage: number
    ttl: number
    /** Grenades: AoE on fuse-end or impact instead of point damage. */
    explode?: { radius: number; damage: number }
    /** Thrown items: the area effect applied where it lands (molotov → fire). */
    onLand?: import('./data/items').AreaEffect
    /** Status inflicted on the entity a bullet strikes (freeze ray, tranq). */
    onHit?: import('./data/items').StatusApply
    // ---- weapon-mod behavior fields (all optional → snapshot-stable). ----
    /** Extra victims to pass through before dying (pierce). Decrements per body. */
    pierceLeft?: number
    /** Wall bounces left — reflect off a blocked tile instead of dying (bounce). */
    bounceLeft?: number
    /** Per-tick turn rate (radians) steering toward the nearest hostile (homing). */
    homing?: number
    /** Spawn N damaging children on the first body it strikes (split/multishot). */
    split?: { count: number; damage: number; speed: number; ttl: number }
    /** Heal the owner by frac·damage dealt on each hit (lifesteal). */
    lifestealFrac?: number
    /** Bodies already struck (pierce), so one victim isn't re-hit every tick. */
    hitIds?: EntityId[]
    /** Resolved trigger effects fired on hit/kill (on-reload handled elsewhere). */
    triggers?: import('./data/mods').ResolvedTrigger[]
    /** Build provenance: the (normalized) mod list of the gun that fired this
     * shot. Pure inert data — no system reads it — carried so the renderer (and
     * net peers, via the snapshot codec) can COMPOSE the bullet's procedural
     * look from its mods, Nova-Drift style. Absent = vanilla shot, so every
     * pre-feature world/fixture serializes byte-for-byte unchanged. */
    mods?: WeaponMod[]
  }
  pickup?: { itemId: string; qty: number }
  door?: { open: boolean; locked: boolean; lockLevel: number }
  interact?: { verb: 'open' | 'pickup' | 'talk' | 'use'; range: number }
  status?: { stun: number; sleep: number; hitFlashUntil: number; cloakUntil: number }
  /** Active status/element effects, keyed by kind ('burning', ...). */
  fx?: Fx
  /** Tiles/objects/actors that fire can catch and spread through. */
  flammable?: boolean
  /** A fire hazard occupying this cell — kind 'fire'. `fuel` burns down 1/tick. */
  fire?: { fuel: number }
  /** Destroyed by shattering a frozen body — an ice gib, not a corpse. */
  shattered?: boolean
  /** A usable object (ATM/vending) that has already dispensed once. */
  used?: boolean
  dead?: boolean
  /** General UI selection state — the player tapped/clicked this entity to point
   * it out. Multi-select: any number of entities may be `selected` at once. Inert
   * to the sim (no system reads it), so it never affects determinism; it rides
   * along in the entity's serialized JSON like any other component. An agent finds
   * selected entities with a normal `entities`/`get` query (filter on this flag). */
  selected?: boolean
}

/** Bare entity with no id — World.addEntity assigns ids so worlds stay self-contained. */
export const makeEntity = (
  kind: EntityKind,
  archetype: string,
  x: number,
  y: number,
  radius = 0.35,
): Entity => ({
  id: 0,
  kind,
  archetype,
  pos: { x, y },
  prevPos: { x, y },
  vel: { x: 0, y: 0 },
  intent: { x: 0, y: 0 },
  speed: 0,
  radius,
  facing: 0,
})
