import { CONSUMABLES, THROWABLES, WEAPONS, itemClass } from '../game/data/items'
import { MODS } from '../game/data/mods'
import type { ItemStack } from '../game/entity'

/** Human-readable name for any carried item id. */
export const itemLabel = (itemId: string): string =>
  WEAPONS[itemId]?.name ?? THROWABLES[itemId]?.name ?? CONSUMABLES[itemId]?.name ?? itemId

/** The mod-badge string for a slot: each mod's icon, repeated is shown as
 * `icon×N` for a stack. Empty when the slot carries no mods, so a vanilla gun
 * renders exactly as before. */
export const modBadge = (stack: ItemStack): string =>
  (stack.mods ?? [])
    .filter((m) => MODS[m.id] && m.stacks > 0)
    .map((m) => `${MODS[m.id].icon}${m.stacks > 1 ? `×${m.stacks}` : ''}`)
    .join(' ')

export interface HotbarSlot {
  /** REAL inventory index — equip/throw act on this, not the display order. */
  index: number
  itemId: string
  label: string
  qty: number
  active: boolean
  /** Weapon-mod badge glyphs (e.g. "❄️ 🪃×2"); empty for a vanilla item. */
  mods: string
}

/** Slots the hotbar must never show: the briefcase (a mission item, not
 * equippable) and WEAPONS. The player's weapon is permanent and cannot be
 * swapped, so its slot exists only to hold weapon-mods — showing it would offer
 * a switch that does nothing, and gamepad cycling walks exactly this list. */
const hidden = (itemId: string): boolean => {
  if (itemId === 'briefcase') return true
  const c = itemClass(itemId)
  return c === 'melee' || c === 'ranged'
}

/**
 * Display slots for the hotbar: every carried HELD item (throwables and
 * consumables), each tagged with its true inventory index. The filter shifts
 * display order, so a tapped strip position must map back through `index` —
 * never assume display position equals inventory slot.
 */
export const hotbarSlots = (inv: ItemStack[], activeSlot: number): HotbarSlot[] =>
  inv
    .map((s, index) => ({ index, itemId: s.itemId, label: itemLabel(s.itemId), qty: s.qty, active: index === activeSlot, mods: modBadge(s) }))
    .filter((s) => !hidden(s.itemId))

/** Whether the player is carrying anything throwable (grenade/molotov/etc). */
export const hasThrowable = (inv: ItemStack[]): boolean => inv.some((s) => itemClass(s.itemId) === 'throwable')
