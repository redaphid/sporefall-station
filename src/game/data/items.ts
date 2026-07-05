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
}

export const WEAPONS: Record<string, WeaponDef> = {
  fists: { id: 'fists', name: 'Fists', kind: 'melee', damage: 8, range: 1.1, cooldownTicks: 12, knockback: 4 },
  bat: { id: 'bat', name: 'Bat', kind: 'melee', damage: 16, range: 1.3, cooldownTicks: 15, knockback: 7 },
  knife: { id: 'knife', name: 'Knife', kind: 'melee', damage: 12, range: 1.1, cooldownTicks: 9, knockback: 2 },
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
  },
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
