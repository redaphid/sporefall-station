// Slot-based inventory + the item-use model. Mirrors the engine's item shape:
// every stack is `{ itemId, qty }` and qty DOUBLES as the item's count — ammo
// for a gun, durability for a melee weapon, a plain quantity for stackables.
// The weapon's *class* (itemClass) picks the use rule: a ranged gun spends a
// round per shot and, when empty, stays in the slot as a dead weight you can't
// fire; a melee weapon spends durability per swing and BREAKS (leaves the slot)
// at zero; a throwable is lobbed and one is spent. Re-expressed from observed
// Streets of Rogue behavior, not ported.
//
// EVERY accessor reads the loadout off `Entity.loadout` (entity.ts `Loadout`),
// the ONE component shared by players and NPCs — so a modded enemy's gun and a
// player's hotbar resolve through exactly the same code. An entity with no
// `loadout` (weaponless townsfolk, a class-starter with no slot) resolves
// VANILLA: undefined stack → infinite ammo, no wear, no mods, exactly as an
// inventory-less NPC behaved before this component existed.

import { CONSUMABLES, itemClass, THROWABLES, WEAPONS } from '../data/items'
import { MODS, modMaxStacks } from '../data/mods'
import { makeEntity, type Entity, type ItemStack, type Loadout } from '../entity'
import { addEntity, type World } from '../world'
import { applyDraftPick } from './draft'
import { applyStatus } from './statusFx'

export const MAX_SLOTS = 6

/** Consumables and throwables merge into one slot; weapons don't. */
export const isStackable = (itemId: string): boolean => {
  const c = itemClass(itemId)
  return c === 'consumable' || c === 'throwable'
}

/** Add `qty` of `itemId` to the slots — stacking a stackable into its existing
 * slot, else taking a fresh slot up to the cap. Returns false only when full. */
export const addItem = (slots: ItemStack[], itemId: string, qty: number): boolean => {
  if (isStackable(itemId)) {
    const existing = slots.find((s) => s.itemId === itemId)
    if (existing) {
      existing.qty += qty
      return true
    }
  }
  if (slots.length >= MAX_SLOTS) return false
  slots.push({ itemId, qty })
  return true
}

/** Equip the weapon in slot `index` — sets it as the active hotbar slot and the
 * entity's swung weapon. Only melee/ranged slots can be equipped. */
const USABLE = new Set(['melee', 'ranged', 'throwable', 'consumable'])

/** Select slot `index` as the active/hotbar slot. Equipping a weapon also makes
 * it the swung weapon; a throwable/consumable just becomes the held item (the
 * one the Use/Throw key acts on) and leaves the current weapon in hand. */
export const equipSlot = (e: Entity, index: number): boolean => {
  const ld = e.loadout
  if (!ld) return false
  const slot = ld.inventory[index]
  if (!slot) return false
  const c = itemClass(slot.itemId)
  if (!USABLE.has(c)) return false
  ld.activeSlot = index
  if (e.combat && (c === 'melee' || c === 'ranged')) e.combat.weapon = slot.itemId
  return true
}

export const activeStack = (e: Entity): ItemStack | undefined => {
  const ld = e.loadout
  if (!ld || ld.activeSlot < 0) return undefined
  return ld.inventory[ld.activeSlot]
}

/** The slot holding the currently-swung weapon (`combat.weapon`). This is NOT
 * always `activeSlot`: a "held" throwable/consumable takes the active slot while
 * a real weapon stays in hand, so durability/ammo must follow the weapon's slot,
 * not whatever is held. Fast-path the common case where they coincide. Returns
 * -1 when the weapon isn't slotted (bare fists, or a class-starter gun). */
const weaponSlotIndex = (e: Entity): number => {
  const ld = e.loadout
  if (!ld || !e.combat) return -1
  const wid = e.combat.weapon
  if (ld.activeSlot >= 0 && ld.inventory[ld.activeSlot]?.itemId === wid) return ld.activeSlot
  return ld.inventory.findIndex((s) => {
    const c = itemClass(s.itemId)
    return s.itemId === wid && (c === 'melee' || c === 'ranged')
  })
}

/** The ItemStack backing the currently-swung weapon — where its `mods` live.
 * Returns undefined when the weapon isn't slotted (bare fists / class-starter
 * gun), so those resolve as vanilla. This is the single lookup the fire site and
 * the `addMod` verb use to reach a gun's mod list — the same for a player or an
 * NPC, so a modded enemy folds its mods into its shots exactly like a player. */
export const weaponStack = (e: Entity): ItemStack | undefined => {
  const index = weaponSlotIndex(e)
  return index < 0 ? undefined : e.loadout!.inventory[index]
}

/** The outcome of grabbing a world weapon-mod pickup: which mod landed on which
 * weapon, and whether it was already maxed (grab confirmed the cap, added nothing). */
export interface ModPickupResult {
  modId: string
  weapon: string
  maxed: boolean
}

/** A freshly materialized weapon arrives whole: full durability for melee, and a
 * flat 1 for a gun, which carries no ammo — the stack is a home for mods, not a
 * round count. Mirrors `startingCount` / a real world pickup. */
const freshWeaponCount = (def: (typeof WEAPONS)[string]): number => def.durability ?? 1

/**
 * Defense in depth for the PHANTOM-weapon state: an entity whose `combat.weapon`
 * names a real, moddable weapon that has NO backing inventory slot (a legacy
 * save from before slotted starters, or any bug that leaves `combat.weapon`
 * dangling). Without a slot there is no `mods` list, so `applyModPickup` would
 * silently drop the mod forever. Materialize the wielded weapon into a real,
 * fully-loaded slot and equip it, so the mod has somewhere to land — retroactively
 * healing the phantom the first time the grabber grabs a mod. Bootstraps a
 * `loadout` if the entity has none. Returns undefined when the wielded weapon
 * genuinely isn't moddable (bare fists / unknown id) or the inventory is full,
 * leaving the caller's leave-on-ground behavior intact. */
const materializeHeldWeapon = (e: Entity): ItemStack | undefined => {
  if (!e.combat) return undefined
  const wid = e.combat.weapon
  const def = WEAPONS[wid]
  // Only real, moddable weapons materialize — fists are innate/unslotted by design.
  if (!def || wid === 'fists') return undefined
  const ld = (e.loadout ??= { inventory: [], activeSlot: -1 })
  if (ld.inventory.length >= MAX_SLOTS) return undefined
  const stack: ItemStack = { itemId: wid, qty: freshWeaponCount(def) }
  ld.inventory.push(stack)
  equipSlot(e, ld.inventory.length - 1)
  return stack
}

/** Apply a scattered weapon-mod pickup to the grabber's currently-swung weapon,
 * reusing the draft's append/stack-cap logic (`applyDraftPick`) so world pickups
 * and the floor draft share ONE write path. If the swung weapon isn't slotted
 * but IS a real moddable weapon (a phantom/legacy state), it is materialized
 * into a slot first so the mod still lands. Returns the result, or `null` when
 * there's genuinely no moddable weapon to receive it — bare fists. The
 * kid-friendly caller leaves such a pickup on the ground so it can be grabbed
 * later once a real gun is in hand (nothing is wasted). */
export const applyModPickup = (e: Entity, modId: string): ModPickupResult | null => {
  if (!MODS[modId]) return null
  const stack = weaponStack(e) ?? materializeHeldWeapon(e)
  if (!stack) return null
  const cap = modMaxStacks(modId)
  const before = stack.mods?.find((m) => m.id === modId)?.stacks ?? 0
  const maxed = before >= cap
  applyDraftPick(stack, modId, 1) // caps internally; a no-op when already maxed
  return { modId, weapon: stack.itemId, maxed }
}

/** Drop a slot; if it held the swung weapon, fall back to bare fists. Keeps
 * activeSlot pointing at the same logical slot as the array shrinks. The
 * weapon-reset keys off the removed item, NOT activeSlot — throwing a held
 * throwable (active slot) must not disarm the weapon in the entity's hand. */
const removeSlot = (e: Entity, index: number): void => {
  const ld = e.loadout!
  const wasWeapon = e.combat !== undefined && ld.inventory[index]?.itemId === e.combat.weapon
  ld.inventory.splice(index, 1)
  if (ld.activeSlot === index) ld.activeSlot = -1
  else if (ld.activeSlot > index) ld.activeSlot -= 1
  if (wasWeapon && e.combat) e.combat.weapon = 'fists'
}

/** A melee swing wears the swung weapon down; at zero durability it breaks and
 * the entity drops to fists. Innate fists (weapon not slotted) never wear. */
export const wearMelee = (e: Entity): void => {
  const index = weaponSlotIndex(e)
  if (index < 0) return
  const stack = e.loadout!.inventory[index]
  stack.qty -= 1
  if (stack.qty <= 0) removeSlot(e, index)
}

const firstThrowableSlot = (ld: Loadout): number => {
  if (ld.activeSlot >= 0 && ld.inventory[ld.activeSlot] && itemClass(ld.inventory[ld.activeSlot].itemId) === 'throwable')
    return ld.activeSlot
  return ld.inventory.findIndex((s) => itemClass(s.itemId) === 'throwable')
}

/** Lob the active (or nearest) throwable as a projectile that applies its
 * element where it lands, and spend one. Returns false with nothing to throw. */
export const throwActive = (w: World, e: Entity): boolean => {
  const ld = e.loadout
  if (!ld) return false
  const index = firstThrowableSlot(ld)
  if (index < 0) return false
  const stack = ld.inventory[index]
  const def = THROWABLES[stack.itemId]
  if (!def) return false

  const proj = makeEntity('projectile', stack.itemId, e.pos.x, e.pos.y, 0.2)
  proj.facing = e.facing
  proj.vel = { x: Math.cos(e.facing) * def.speed, y: Math.sin(e.facing) * def.speed }
  proj.projectile = {
    ownerId: e.id,
    damage: def.damage,
    ttl: Math.ceil((def.range / def.speed) * 30),
    onLand: def.onLand,
  }
  addEntity(w, proj)

  stack.qty -= 1
  if (stack.qty <= 0) removeSlot(e, index)
  return true
}

/** Consume the active consumable: heal and/or apply its self buff, then spend
 * one. Returns false if the active slot isn't a consumable. */
const consumeActive = (w: World, e: Entity): boolean => {
  const ld = e.loadout
  if (!ld || ld.activeSlot < 0) return false
  const stack = ld.inventory[ld.activeSlot]
  const def = stack && CONSUMABLES[stack.itemId]
  if (!def) return false
  if (def.heal && e.health) e.health.hp = Math.min(e.health.max, e.health.hp + def.heal)
  if (def.onUse) applyStatus(w, e, def.onUse.status, def.onUse.ticks)
  stack.qty -= 1
  if (stack.qty <= 0) removeSlot(e, ld.activeSlot)
  return true
}

/** The Use/Throw action: consume the held consumable, else lob a throwable. */
export const useHeld = (w: World, e: Entity): boolean => consumeActive(w, e) || throwActive(w, e)
