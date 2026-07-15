// The item table. Behaviors are DECLARATIVE — a weapon carries an `onHit`
// status, a throwable an `onLand` area effect, a consumable an `onUse` effect —
// so the systems dispatch on data, never on item ids. Values re-expressed from
// the decompiled ItemFunctions/InvItem behavior (read to understand; authored
// fresh), not ported.

/** A status applied to a struck entity (freeze ray → frozen, tranq → sleep). */
export interface StatusApply {
  status: string
  ticks: number
}

/** What a thrown item does where it lands. */
export type AreaEffect =
  | { kind: 'fire' }
  | { kind: 'explode'; radius: number; damage: number }
  | { kind: 'status'; status: string; ticks: number; radius: number }

export interface WeaponDef {
  id: string
  name: string
  kind: 'melee' | 'ranged'
  damage: number
  /** Attack reach in tiles (melee) or projectile lifetime range (ranged). */
  range: number
  cooldownTicks: number
  knockback: number
  /** Ranged only. */
  projectileSpeed?: number
  ammoPerShot?: number
  /** Ranged: rounds a full slot holds — the slot's count doubles as ammo. */
  magSize?: number
  /** Melee: swings before it breaks — the slot's count doubles as durability.
   * Absent (fists) = innate, never consumed. */
  durability?: number
  /** Ranged: pellets fired per shot across `spread` radians (shotgun). */
  pellets?: number
  spread?: number
  /** Status inflicted on whatever the hit lands on (freeze ray, sledgehammer). */
  onHit?: StatusApply
}

export const WEAPONS: Record<string, WeaponDef> = {
  fists: { id: 'fists', name: 'Fists', kind: 'melee', damage: 8, range: 1.1, cooldownTicks: 12, knockback: 4 },
  bat: { id: 'bat', name: 'Bat', kind: 'melee', damage: 16, range: 1.3, cooldownTicks: 15, knockback: 7, durability: 16 },
  knife: { id: 'knife', name: 'Knife', kind: 'melee', damage: 12, range: 1.1, cooldownTicks: 9, knockback: 2, durability: 20 },
  sledgehammer: {
    id: 'sledgehammer',
    name: 'Sledgehammer',
    kind: 'melee',
    damage: 26,
    range: 1.4,
    cooldownTicks: 28,
    knockback: 16,
    durability: 12,
    onHit: { status: 'stun', ticks: 20 },
  },
  pistol: {
    id: 'pistol',
    name: 'Pistol',
    kind: 'ranged',
    damage: 14,
    range: 10,
    cooldownTicks: 18,
    knockback: 3,
    projectileSpeed: 14,
    ammoPerShot: 1,
    magSize: 8,
  },
  shotgun: {
    id: 'shotgun',
    name: 'Shotgun',
    kind: 'ranged',
    damage: 7,
    range: 6,
    cooldownTicks: 26,
    knockback: 4,
    projectileSpeed: 16,
    magSize: 6,
    pellets: 5,
    spread: 0.5,
  },
  machinegun: {
    id: 'machinegun',
    name: 'Machine Gun',
    kind: 'ranged',
    damage: 8,
    range: 9,
    cooldownTicks: 5,
    knockback: 1,
    projectileSpeed: 16,
    magSize: 30,
  },
  freezeRay: {
    id: 'freezeRay',
    name: 'Freeze Ray',
    kind: 'ranged',
    damage: 0,
    range: 8,
    cooldownTicks: 22,
    knockback: 0,
    projectileSpeed: 13,
    magSize: 6,
    onHit: { status: 'frozen', ticks: 120 },
  },
  tranquilizer: {
    id: 'tranquilizer',
    name: 'Tranquilizer',
    kind: 'ranged',
    damage: 0,
    range: 8,
    cooldownTicks: 20,
    knockback: 0,
    projectileSpeed: 13,
    magSize: 5,
    onHit: { status: 'sleep', ticks: 150 },
  },
}

/** Throwables: lobbed as a projectile that applies its `onLand` effect. */
export interface ThrowableDef {
  id: string
  name: string
  speed: number
  range: number
  damage: number
  onLand: AreaEffect
  cooldownTicks: number
}

export const THROWABLES: Record<string, ThrowableDef> = {
  molotov: { id: 'molotov', name: 'Molotov', speed: 9, range: 6, damage: 0, onLand: { kind: 'fire' }, cooldownTicks: 20 },
  grenade: { id: 'grenade', name: 'Grenade', speed: 8, range: 6, damage: 0, onLand: { kind: 'explode', radius: 2.2, damage: 40 }, cooldownTicks: 25 },
  freezeGrenade: { id: 'freezeGrenade', name: 'Freeze Grenade', speed: 9, range: 6, damage: 0, onLand: { kind: 'status', status: 'frozen', ticks: 120, radius: 2 }, cooldownTicks: 20 },
  chloroform: { id: 'chloroform', name: 'Chloroform', speed: 8, range: 4, damage: 0, onLand: { kind: 'status', status: 'sleep', ticks: 180, radius: 1.8 }, cooldownTicks: 20 },
  banana: { id: 'banana', name: 'Banana Peel', speed: 7, range: 4, damage: 0, onLand: { kind: 'status', status: 'slip', ticks: 45, radius: 1.2 }, cooldownTicks: 15 },
  gasGrenade: { id: 'gasGrenade', name: 'Gas Grenade', speed: 8, range: 5, damage: 0, onLand: { kind: 'status', status: 'poisoned', ticks: 150, radius: 2 }, cooldownTicks: 20 },
}

export interface ConsumableDef {
  id: string
  name: string
  heal?: number
  /** A self status applied on use (adrenaline → buff). */
  onUse?: StatusApply
}

export const CONSUMABLES: Record<string, ConsumableDef> = {
  bandage: { id: 'bandage', name: 'Bandage', heal: 30 },
  medkit: { id: 'medkit', name: 'Medkit', heal: 100 },
  burger: { id: 'burger', name: 'Burger', heal: 20 },
  adrenaline: { id: 'adrenaline', name: 'Adrenaline', onUse: { status: 'hasted', ticks: 300 } },
}

export type ItemClass = 'melee' | 'ranged' | 'throwable' | 'consumable' | 'ammo' | 'key' | 'cash' | 'unknown'

/** What kind of thing an item id is — the switch every use-rule dispatches on. */
export const itemClass = (itemId: string): ItemClass => {
  if (itemId === 'cash') return 'cash'
  if (itemId === 'briefcase') return 'key'
  if (itemId === 'ammo') return 'ammo'
  if (WEAPONS[itemId]) return WEAPONS[itemId].kind
  if (THROWABLES[itemId]) return 'throwable'
  if (CONSUMABLES[itemId]) return 'consumable'
  return 'unknown'
}
