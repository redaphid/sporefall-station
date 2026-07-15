// Slot-based inventory + the item-use model. Mirrors the engine's item shape:
// every stack is `{ itemId, qty }` and qty DOUBLES as the item's count — ammo
// for a gun, durability for a melee weapon, a plain quantity for stackables.
// The weapon's *class* (itemClass) picks the use rule: a ranged gun spends a
// round per shot and, when empty, stays in the slot as a dead weight you can't
// fire; a melee weapon spends durability per swing and BREAKS (leaves the slot)
// at zero; a throwable is lobbed and one is spent. Re-expressed from observed
// Streets of Rogue behavior, not ported.

import { CONSUMABLES, itemClass, THROWABLES } from '../data/items'
import { makeEntity, type Entity, type ItemStack } from '../entity'
import { addEntity, type World } from '../world'
import { applyStatus } from './statusFx'

export const MAX_SLOTS = 6

/** Consumables, ammo and throwables merge into one slot; weapons don't. */
export const isStackable = (itemId: string): boolean => {
  const c = itemClass(itemId)
  return c === 'consumable' || c === 'ammo' || c === 'throwable'
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
  const ctl = e.playerCtl
  if (!ctl) return false
  const slot = ctl.inventory[index]
  if (!slot) return false
  const c = itemClass(slot.itemId)
  if (!USABLE.has(c)) return false
  ctl.activeSlot = index
  if (e.combat && (c === 'melee' || c === 'ranged')) e.combat.weapon = slot.itemId
  return true
}

export const activeStack = (e: Entity): ItemStack | undefined => {
  const ctl = e.playerCtl
  if (!ctl || ctl.activeSlot < 0) return undefined
  return ctl.inventory[ctl.activeSlot]
}

/** The slot holding the currently-swung weapon (`combat.weapon`). This is NOT
 * always `activeSlot`: a "held" throwable/consumable takes the active slot while
 * a real weapon stays in hand, so durability/ammo must follow the weapon's slot,
 * not whatever is held. Fast-path the common case where they coincide. Returns
 * -1 when the weapon isn't slotted (bare fists, or a class-starter gun). */
const weaponSlotIndex = (e: Entity): number => {
  const ctl = e.playerCtl
  if (!ctl || !e.combat) return -1
  const wid = e.combat.weapon
  if (ctl.activeSlot >= 0 && ctl.inventory[ctl.activeSlot]?.itemId === wid) return ctl.activeSlot
  return ctl.inventory.findIndex((s) => {
    const c = itemClass(s.itemId)
    return s.itemId === wid && (c === 'melee' || c === 'ranged')
  })
}

/** The ItemStack backing the currently-swung weapon — where its `mods` live.
 * Returns undefined when the weapon isn't slotted (bare fists / class-starter
 * gun), so those resolve as vanilla. This is the single lookup the fire site and
 * the `addMod` verb use to reach a gun's mod list. */
export const weaponStack = (e: Entity): ItemStack | undefined => {
  const index = weaponSlotIndex(e)
  return index < 0 ? undefined : e.playerCtl!.inventory[index]
}

/** Drop a slot; if it held the swung weapon, fall back to bare fists. Keeps
 * activeSlot pointing at the same logical slot as the array shrinks. The
 * weapon-reset keys off the removed item, NOT activeSlot — throwing a held
 * throwable (active slot) must not disarm the weapon in the player's hand. */
const removeSlot = (e: Entity, index: number): void => {
  const ctl = e.playerCtl!
  const wasWeapon = e.combat !== undefined && ctl.inventory[index]?.itemId === e.combat.weapon
  ctl.inventory.splice(index, 1)
  if (ctl.activeSlot === index) ctl.activeSlot = -1
  else if (ctl.activeSlot > index) ctl.activeSlot -= 1
  if (wasWeapon && e.combat) e.combat.weapon = 'fists'
}

/** A melee swing wears the swung weapon down; at zero durability it breaks and
 * the entity drops to fists. Innate fists (weapon not slotted) never wear. */
export const wearMelee = (e: Entity): void => {
  const index = weaponSlotIndex(e)
  if (index < 0) return
  const stack = e.playerCtl!.inventory[index]
  stack.qty -= 1
  if (stack.qty <= 0) removeSlot(e, index)
}

/** Try to spend one round from the swung gun. Returns false when empty — the
 * gun stays in the slot (empty, can't fire) rather than vanishing. */
export const spendAmmo = (e: Entity): boolean => {
  const index = weaponSlotIndex(e)
  if (index < 0) return true // gun not slotted (e.g. class starter): treat as unlimited
  const stack = e.playerCtl!.inventory[index]
  if (stack.qty <= 0) return false
  stack.qty -= 1
  return true
}

const firstThrowableSlot = (ctl: NonNullable<Entity['playerCtl']>): number => {
  if (ctl.activeSlot >= 0 && ctl.inventory[ctl.activeSlot] && itemClass(ctl.inventory[ctl.activeSlot].itemId) === 'throwable')
    return ctl.activeSlot
  return ctl.inventory.findIndex((s) => itemClass(s.itemId) === 'throwable')
}

/** Lob the active (or nearest) throwable as a projectile that applies its
 * element where it lands, and spend one. Returns false with nothing to throw. */
export const throwActive = (w: World, e: Entity): boolean => {
  const ctl = e.playerCtl
  if (!ctl) return false
  const index = firstThrowableSlot(ctl)
  if (index < 0) return false
  const stack = ctl.inventory[index]
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
  const ctl = e.playerCtl
  if (!ctl || ctl.activeSlot < 0) return false
  const stack = ctl.inventory[ctl.activeSlot]
  const def = stack && CONSUMABLES[stack.itemId]
  if (!def) return false
  if (def.heal && e.health) e.health.hp = Math.min(e.health.max, e.health.hp + def.heal)
  if (def.onUse) applyStatus(w, e, def.onUse.status, def.onUse.ticks)
  stack.qty -= 1
  if (stack.qty <= 0) removeSlot(e, ctl.activeSlot)
  return true
}

/** The Use/Throw action: consume the held consumable, else lob a throwable. */
export const useHeld = (w: World, e: Entity): boolean => consumeActive(w, e) || throwActive(w, e)
