import { CONSUMABLES, THROWABLES, WEAPONS, itemClass } from '../game/data/items'
import { MODS } from '../game/data/mods'
import { weaponStack } from '../game/systems/inventory'
import type { Entity, ItemStack } from '../game/entity'

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

/** Slot classes the hotbar shows: the selectable held items. WEAPONS ARE
 * EXCLUDED — the player's single permanent weapon is not a hotbar choice, so
 * there is no weapon-selected indicator and no ammo count to render. The
 * briefcase (a mission item) is excluded too. */
const SHOWN = new Set(['throwable', 'consumable'])

/**
 * Display slots for the hotbar: every selectable held item, each tagged with its
 * true inventory index. The filter shifts display order, so a tapped strip
 * position must map back through `index` — never assume display position equals
 * inventory slot.
 */
export const hotbarSlots = (inv: ItemStack[], activeSlot: number): HotbarSlot[] =>
  inv
    .map((s, index) => ({ index, itemId: s.itemId, label: itemLabel(s.itemId), qty: s.qty, active: index === activeSlot, mods: modBadge(s) }))
    .filter((s) => SHOWN.has(itemClass(s.itemId)))

/**
 * The mod-badge string for the player's PERMANENT weapon, for the always-on HUD.
 *
 * Load-bearing, and easy to delete by accident: mods live ONLY on the weapon's
 * `ItemStack` (`weaponStack`), and the hotbar above no longer renders the weapon
 * slot — correctly, since there is nothing to select. But the weapon slot's badge
 * used to be the only always-visible mod readout during play. Without this, mods
 * would be invisible the entire time you are actually fighting, and only appear
 * when you PAUSE or DIE (the loadout panel) — i.e. the run's whole progression
 * would be hidden exactly when it matters. The HUD reads this directly instead.
 */
export const equippedModBadge = (e: Entity): string => {
  const stack = weaponStack(e)
  return stack ? modBadge(stack) : ''
}

/** Whether the player is carrying anything throwable (grenade/molotov/etc). */
export const hasThrowable = (inv: ItemStack[]): boolean => inv.some((s) => itemClass(s.itemId) === 'throwable')
