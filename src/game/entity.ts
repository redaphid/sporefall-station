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
}

export interface ItemStack {
  itemId: string
  qty: number
}

export interface Entity {
  id: EntityId
  kind: EntityKind
  /** Key into data/ definitions: 'thug', 'cop', 'soldier', 'medkit', 'door.wood', ... */
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
    classId: string
    abilityCooldown: number
    inventory: ItemStack[]
    cash: number
    crimeUntilTick: number
    downed?: { bleedTicks: number; reviveProgress: number }
    /** Timed action in progress (lockpicking). Moving cancels it. */
    channel?: { kind: 'lockpick'; targetId: EntityId; ticksLeft: number }
  }
  projectile?: {
    ownerId: EntityId
    damage: number
    ttl: number
    /** Grenades: AoE on fuse-end or impact instead of point damage. */
    explode?: { radius: number; damage: number }
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
  dead?: boolean
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
