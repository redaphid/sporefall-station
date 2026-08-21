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
  /** Melee: swings before it breaks — the slot's count doubles as durability.
   * Absent (natural armament) = innate, never consumed. */
  durability?: number
  /** NATURAL armament — grown, not carried (fists, a Mireclaw's claws). It has
   * no durability (nothing to break), never drops as loot, and draws no held
   * sprite (render/weaponArt.hasHeldWeapon). The one flag that distinguishes
   * "this creature's body" from "a weapon it picked up". */
  natural?: true
  /** Ranged: pellets fired per shot across `spread` radians (shotgun). */
  pellets?: number
  spread?: number
  /** Status inflicted on whatever the hit lands on (freeze ray, sledgehammer). */
  onHit?: StatusApply
}

export const WEAPONS: Record<string, WeaponDef> = {
  fists: { id: 'fists', name: 'Fists', kind: 'melee', damage: 8, range: 1.1, cooldownTicks: 12, knockback: 4, natural: true },
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
  // The Mireclaw Alpha's natural armament. A baseball bat on an apex swamp
  // predator was the placeholder that made the boss read as a fat gangster;
  // claws are innate, so they carry no durability and draw NO held sprite
  // (render/weaponArt treats them like fists). Roughly bat DPS, but landed in
  // fewer, heavier, longer-reach blows — a hit you feel and roll away from
  // rather than a chip you tank.
  claws: { id: 'claws', name: 'Claws', kind: 'melee', damage: 22, range: 1.5, cooldownTicks: 20, knockback: 12, natural: true },
  pistol: {
    id: 'pistol',
    name: 'Pistol',
    kind: 'ranged',
    damage: 14,
    range: 10,
    cooldownTicks: 18,
    knockback: 3,
    projectileSpeed: 14,
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
    onHit: { status: 'sleep', ticks: 150 },
  },
  flamethrower: {
    id: 'flamethrower',
    name: 'Flamethrower',
    kind: 'ranged',
    damage: 3,
    range: 5,
    cooldownTicks: 6,
    knockback: 0,
    projectileSpeed: 11,
    onHit: { status: 'burning', ticks: 240 },
  },
  stunGun: {
    id: 'stunGun',
    name: 'Stun Gun',
    kind: 'ranged',
    damage: 2,
    range: 5,
    cooldownTicks: 24,
    knockback: 1,
    projectileSpeed: 14,
    onHit: { status: 'electrified', ticks: 45 },
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

// The element throwables (molotov / freezeGrenade / chloroform / banana /
// gasGrenade) were CULLED — the grenade is the one thing you throw now. The
// `AreaEffect` union deliberately keeps its `fire` and `status` arms: nothing
// in this table produces them today, but fire still arrives from barrels,
// `ignite` objects and the `incendiary` mod, and statuses still arrive from
// weapon `onHit`, so the throw pipeline stays general rather than being
// narrowed to `explode` and having to be widened again.
export const THROWABLES: Record<string, ThrowableDef> = {
  grenade: { id: 'grenade', name: 'Grenade', speed: 8, range: 6, damage: 0, onLand: { kind: 'explode', radius: 2.2, damage: 40 }, cooldownTicks: 25 },
}

export interface ConsumableDef {
  id: string
  name: string
  heal?: number
  /** A self status applied on use (e.g. a stimulant → `hasted`). */
  onUse?: StatusApply
}

/**
 * EMPTY BY DECISION, not by accident. bandage / medkit / burger / adrenaline
 * were culled, and they were the whole consumable class — so there is no
 * item-based healing or item-based self-buff in the game any more. Healing now
 * comes only from passive regen (systems/regen.ts) and the `lifesteal` weapon
 * mod.
 *
 * The table, the `ConsumableDef` shape and every consumer of them are kept: the
 * item pipeline dispatches on data (`itemClass` → 'consumable' → `consumeActive`
 * → heal/onUse), so a future consumable is one line here and nothing else. An
 * id that is NOT in this table classes as 'unknown' and is inert — it cannot be
 * used, and no code path indexes this table unguarded (see the `itemClass`
 * gate in systems/interaction.ts `collect` and the `if (!def) return false` in
 * systems/inventory.ts `consumeActive`). That is what makes an old save or an
 * older peer's snapshot carrying `medkit` harmless rather than a crash.
 */
export const CONSUMABLES: Record<string, ConsumableDef> = {}

export type ItemClass = 'melee' | 'ranged' | 'throwable' | 'consumable' | 'key' | 'cash' | 'unknown'

/** What kind of thing an item id is — the switch every use-rule dispatches on. */
export const itemClass = (itemId: string): ItemClass => {
  if (itemId === 'cash') return 'cash'
  if (itemId === 'briefcase') return 'key'
  // Wing keycards ('keycard' or 'keycard.<wing>'): a key-class item, so they
  // ignore slot limits, survive a down (recover keeps only 'key' items), and
  // ride across floors (nextFloor drops only the briefcase). See interaction.ts.
  if (itemId === 'keycard' || itemId.startsWith('keycard.')) return 'key'
  if (WEAPONS[itemId]) return WEAPONS[itemId].kind
  if (THROWABLES[itemId]) return 'throwable'
  if (CONSUMABLES[itemId]) return 'consumable'
  return 'unknown'
}
