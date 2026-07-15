// Interactive & destructible world objects — data-driven, grounded in the
// decompiled ObjectReal hierarchy (ExplodingBarrel, Crate, ATMMachine,
// vending), authored fresh. Each object has hp and declares what it does when
// destroyed (spill loot, blast, ignite) and/or when used (dispense cash/item).

export interface ObjectDef {
  id: string
  name: string
  hp: number
  /** Hits weaker than this bounce off (ExplodingBarrel.damageThreshold = 5). */
  damageThreshold?: number
  /** Fire can catch and spread through it. */
  flammable?: boolean
  /** Blast dealt when destroyed (explosive barrel). */
  explode?: { radius: number; damage: number }
  /** Start a fire where it dies. */
  ignite?: boolean
  /** Loot table — one entry spilled as a pickup on destruction (via run PRNG). */
  loot?: string[]
  /** E-interact: dispense cash or an item id once. */
  use?: { gives: 'cash' | string; amount?: number }
  /** Can be shorted out by a hacker. */
  hackable?: boolean
}

export const OBJECTS: Record<string, ObjectDef> = {
  crate: { id: 'crate', name: 'Crate', hp: 20, flammable: true, loot: ['bat', 'knife', 'bandage', 'molotov', 'cash'] },
  barrel: { id: 'barrel', name: 'Barrel', hp: 15, damageThreshold: 5, flammable: true, explode: { radius: 2.4, damage: 40 }, ignite: true },
  tv: { id: 'tv', name: 'TV', hp: 12, loot: ['cash'] },
  toilet: { id: 'toilet', name: 'Toilet', hp: 10 },
  vending: { id: 'vending', name: 'Vending Machine', hp: 40, loot: ['cash'], use: { gives: 'burger' } },
  atm: { id: 'atm', name: 'ATM', hp: 50, hackable: true, use: { gives: 'cash', amount: 50 } },
  generator: { id: 'generator', name: 'Generator', hp: 30, hackable: true, explode: { radius: 1.6, damage: 15 }, ignite: true },
}
