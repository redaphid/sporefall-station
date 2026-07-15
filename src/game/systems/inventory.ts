// Slot-based inventory + the item-use model. Mirrors the engine's item shape:
// every stack is `{ itemId, qty }` and qty DOUBLES as the item's count — ammo
// for a gun, durability for a melee weapon, a plain quantity for stackables.
// The weapon's *class* (itemClass) picks the use rule: a ranged gun spends a
// round per shot and, when empty, stays in the slot as a dead weight you can't
// fire; a melee weapon spends durability per swing and BREAKS (leaves the slot)
// at zero; a throwable is lobbed and one is spent. Re-expressed from observed
// Streets of Rogue behavior, not ported.

import { itemClass, THROWABLES } from '../data/items'
import { makeEntity, type Entity, type ItemStack } from '../entity'
import { addEntity, type World } from '../world'

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
export const equipSlot = (e: Entity, index: number): boolean => {
  const ctl = e.playerCtl
  if (!ctl) return false
  const slot = ctl.inventory[index]
  if (!slot) return false
  const c = itemClass(slot.itemId)
  if (c !== 'melee' && c !== 'ranged') return false
  ctl.activeSlot = index
  if (e.combat) e.combat.weapon = slot.itemId
  return true
}

export const activeStack = (e: Entity): ItemStack | undefined => {
  const ctl = e.playerCtl
  if (!ctl || ctl.activeSlot < 0) return undefined
  return ctl.inventory[ctl.activeSlot]
}

/** Drop a slot and, if it was equipped, fall back to bare fists. Keeps
 * activeSlot pointing at the same logical slot as the array shrinks. */
const removeSlot = (e: Entity, index: number): void => {
  const ctl = e.playerCtl!
  ctl.inventory.splice(index, 1)
  if (ctl.activeSlot === index) {
    ctl.activeSlot = -1
    if (e.combat) e.combat.weapon = 'fists'
  } else if (ctl.activeSlot > index) {
    ctl.activeSlot -= 1
  }
}

/** A melee swing wears the active weapon down; at zero durability it breaks and
 * the entity drops to fists. Innate fists (no active slot) never wear. */
export const wearMelee = (e: Entity): void => {
  const stack = activeStack(e)
  if (!stack) return
  stack.qty -= 1
  if (stack.qty <= 0) removeSlot(e, e.playerCtl!.activeSlot)
}

/** Try to spend one round from the equipped gun. Returns false when empty — the
 * gun stays in the slot (empty, can't fire) rather than vanishing. */
export const spendAmmo = (e: Entity): boolean => {
  const stack = activeStack(e)
  if (!stack) return true // gun not slotted (e.g. class starter): treat as unlimited
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
    onImpact: def.impact,
  }
  addEntity(w, proj)

  stack.qty -= 1
  if (stack.qty <= 0) removeSlot(e, index)
  return true
}
