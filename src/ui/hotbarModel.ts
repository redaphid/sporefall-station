import { CONSUMABLES, THROWABLES, WEAPONS, itemClass } from '../game/data/items'
import { MODS } from '../game/data/mods'
import type { ItemStack } from '../game/entity'

/** Human-readable name for any carried item id. */
export const itemLabel = (itemId: string): string =>
  WEAPONS[itemId]?.name ?? THROWABLES[itemId]?.name ?? CONSUMABLES[itemId]?.name ?? (itemId === 'ammo' ? 'Ammo' : itemId)

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

/**
 * Display slots for the hotbar: every carried item except the briefcase (a
 * mission item, not equippable), each tagged with its true inventory index.
 * The briefcase filter shifts display order, so a tapped strip position must map
 * back through `index` — never assume display position equals inventory slot.
 */
export const hotbarSlots = (inv: ItemStack[], activeSlot: number): HotbarSlot[] =>
  inv
    .map((s, index) => ({ index, itemId: s.itemId, label: itemLabel(s.itemId), qty: s.qty, active: index === activeSlot, mods: modBadge(s) }))
    .filter((s) => s.itemId !== 'briefcase')

/** Whether the player is carrying anything throwable (grenade/molotov/etc). */
export const hasThrowable = (inv: ItemStack[]): boolean => inv.some((s) => itemClass(s.itemId) === 'throwable')
