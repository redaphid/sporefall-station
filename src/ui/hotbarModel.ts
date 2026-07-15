import { CONSUMABLES, THROWABLES, WEAPONS, itemClass } from '../game/data/items'
import type { ItemStack } from '../game/entity'

/** Human-readable name for any carried item id. */
export const itemLabel = (itemId: string): string =>
  WEAPONS[itemId]?.name ?? THROWABLES[itemId]?.name ?? CONSUMABLES[itemId]?.name ?? (itemId === 'ammo' ? 'Ammo' : itemId)

export interface HotbarSlot {
  /** REAL inventory index — equip/throw act on this, not the display order. */
  index: number
  itemId: string
  label: string
  qty: number
  active: boolean
}

/**
 * Display slots for the hotbar: every carried item except the briefcase (a
 * mission item, not equippable), each tagged with its true inventory index.
 * The briefcase filter shifts display order, so a tapped strip position must map
 * back through `index` — never assume display position equals inventory slot.
 */
export const hotbarSlots = (inv: ItemStack[], activeSlot: number): HotbarSlot[] =>
  inv
    .map((s, index) => ({ index, itemId: s.itemId, label: itemLabel(s.itemId), qty: s.qty, active: index === activeSlot }))
    .filter((s) => s.itemId !== 'briefcase')

/** Whether the player is carrying anything throwable (grenade/molotov/etc). */
export const hasThrowable = (inv: ItemStack[]): boolean => inv.some((s) => itemClass(s.itemId) === 'throwable')
