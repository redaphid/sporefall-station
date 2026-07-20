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
  /** Electronics: interactable even without a `use` payout (e.g. generator). */
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
  // Sporefall Station power plant — same hackable behavior as `generator`, dressed
  // as the station's Cryo Terminal so a power-cut objective reads in-fiction.
  cryoTerminal: { id: 'cryoTerminal', name: 'Cryo Terminal', hp: 30, hackable: true },
  // Increment B "The Living Seal": the Spore Node — a stationary bog organ that
  // keeps its linked hatches overgrown. Flammable (fire kills it) with real hp
  // (shoot it down), and it spills fungal loot. Its DEATH un-overgrows every
  // hatch whose `door.nodeId` points at it (interaction.sealSystem).
  sporeNode: { id: 'sporeNode', name: 'Spore Node', hp: 45, flammable: true, ignite: true, loot: ['bandage', 'gasGrenade', 'molotov', 'cash'] },
}
