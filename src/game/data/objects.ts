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

  // ── Interior furnishings (feat/levelgen-fill-interiors) ──────────────────
  // Role-appropriate props that make a room read as OCCUPIED and legible rather
  // than an empty box. Placed by populate.furnishInteriors on its own rng fork.
  // They behave like every other world object — soft, destructible obstacles —
  // and a few spill role-flavoured loot when smashed, so a stockroom or armory
  // rewards a demolition. Bespoke sprite art is a deferred follow-up; the
  // renderer draws them as tinted footprint boxes for now.
  // A defender-built junk barrier (behaviors.ts `fortify`): a soft, destructible
  // body that plugs a doorway approach — shove past it slowly or smash through.
  // Deliberately mundane: no explosion, no fire, no loot; its whole job is hp.
  barricade: { id: 'barricade', name: 'Junk Barricade', hp: 40 },
  bunk: { id: 'bunk', name: 'Bunk', hp: 25, flammable: true, loot: ['bandage', 'cash'] },
  desk: { id: 'desk', name: 'Desk', hp: 20, flammable: true, loot: ['cash'] },
  shelf: { id: 'shelf', name: 'Shelving', hp: 18, flammable: true, loot: ['bandage', 'cash', 'molotov'] },
  cabinet: { id: 'cabinet', name: 'Supply Cabinet', hp: 22, loot: ['medkit', 'bandage'] },
  bench: { id: 'bench', name: 'Lab Bench', hp: 24, loot: ['bandage', 'gasGrenade'] },
  locker: { id: 'locker', name: 'Weapons Locker', hp: 30, loot: ['knife', 'pistol', 'cash'] },
  table: { id: 'table', name: 'Table', hp: 16, flammable: true },
  // The thing every table in this game was missing. A chair is placed BY the
  // layout planner, never alone: pulled up to a desk, ringed round a table, or
  // drawn up facing a screen — and turned to face whatever it belongs to. Light
  // and cheap to smash, because its job is to say "someone sits here", not to
  // be cover.
  chair: { id: 'chair', name: 'Chair', hp: 10, flammable: true },
  plant: { id: 'plant', name: 'Planter', hp: 10, flammable: true },
}
