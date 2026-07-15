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
}

export const WEAPONS: Record<string, WeaponDef> = {
  fists: { id: 'fists', name: 'Fists', kind: 'melee', damage: 8, range: 1.1, cooldownTicks: 12, knockback: 4 },
  bat: { id: 'bat', name: 'Bat', kind: 'melee', damage: 16, range: 1.3, cooldownTicks: 15, knockback: 7, durability: 16 },
  knife: { id: 'knife', name: 'Knife', kind: 'melee', damage: 12, range: 1.1, cooldownTicks: 9, knockback: 2, durability: 20 },
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
}

/** Throwables: lobbed as a projectile that applies an element on impact. */
export interface ThrowableDef {
  id: string
  name: string
  speed: number
  range: number
  damage: number
  /** What lands where it hits. */
  impact: 'fire'
  cooldownTicks: number
}

export const THROWABLES: Record<string, ThrowableDef> = {
  molotov: { id: 'molotov', name: 'Molotov', speed: 9, range: 6, damage: 0, impact: 'fire', cooldownTicks: 20 },
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

export interface ConsumableDef {
  id: string
  name: string
  heal?: number
}

export const CONSUMABLES: Record<string, ConsumableDef> = {
  bandage: { id: 'bandage', name: 'Bandage', heal: 30 },
  medkit: { id: 'medkit', name: 'Medkit', heal: 100 },
}
