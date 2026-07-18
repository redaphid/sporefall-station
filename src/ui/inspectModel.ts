// Pure builder for the tap-inspect readout — a friendly subset of an entity's
// components (name/kind, hp, faction/disposition, door lock, interact verb, item
// effect). Kept DOM-free so the overlay just renders the rows and tests assert on
// them. Reads live entity fields plus the data tables for human-facing names.

import type { Entity, ItemStack } from '../game/entity'
import { NPCS } from '../game/data/npcs'
import { CONSUMABLES, THROWABLES, WEAPONS } from '../game/data/items'
import { MODS } from '../game/data/mods'
import { weaponStack } from '../game/systems/inventory'

export interface InspectRow {
  label: string
  value: string
}

export interface InspectCard {
  title: string
  rows: InspectRow[]
}

/** Title-case an archetype key like `door.wood` → `Door Wood`. */
const pretty = (s: string): string =>
  s
    .split(/[._-]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ')

/** Human name for whichever weapon/throwable/consumable id we can resolve. */
const itemName = (id: string): string => WEAPONS[id]?.name ?? THROWABLES[id]?.name ?? CONSUMABLES[id]?.name ?? pretty(id)

/** One inspect row per weapon mod on a stack: "❄️ Cryo Rounds" → "×N". Empty for
 * a vanilla / absent stack, so an unmodded gun shows just the Weapon row. */
const modRows = (stack: ItemStack | undefined): InspectRow[] =>
  (stack?.mods ?? [])
    .filter((m) => MODS[m.id] && m.stacks > 0)
    .map((m) => ({ label: `${MODS[m.id].icon} ${MODS[m.id].name}`, value: `×${m.stacks}` }))

/**
 * Build the friendly inspect card for an entity. Only rows that apply are
 * emitted, so a plain prop shows a short card and a rich NPC a fuller one. Never
 * throws on missing fields — every lookup is defensive.
 */
export const inspectCard = (e: Entity): InspectCard => {
  const rows: InspectRow[] = []
  const title = `${pretty(e.archetype)} · ${e.kind}`

  if (e.health) rows.push({ label: 'HP', value: `${Math.max(0, Math.round(e.health.hp))}/${e.health.max}` })

  if (e.ai) {
    const def = NPCS[e.archetype]
    rows.push({ label: 'Faction', value: pretty(e.ai.faction ?? def?.faction ?? 'neutral') })
    // Disposition: the AI's current goal/mode is the closest friendly read.
    if (e.ai.goal) rows.push({ label: 'Disposition', value: pretty(e.ai.goal) })
    else if (e.ai.mode) rows.push({ label: 'Disposition', value: pretty(e.ai.mode) })
  }

  if (e.playerCtl) {
    rows.push({ label: 'Player', value: `P${e.playerCtl.playerId + 1}` })
    if (e.playerCtl.downed) rows.push({ label: 'State', value: 'Downed' })
  }

  if (e.door) {
    rows.push({ label: 'Door', value: e.door.open ? 'Open' : e.door.locked ? `Locked (L${e.door.lockLevel})` : 'Closed' })
  }

  if (e.combat?.weapon) {
    rows.push({ label: 'Weapon', value: itemName(e.combat.weapon) })
    // Surface the equipped gun's mods so a kid can SEE their build (#41/#51).
    if (e.playerCtl) for (const r of modRows(weaponStack(e))) rows.push(r)
  }

  if (e.pickup) {
    const mod = MODS[e.pickup.itemId]
    if (mod) {
      // A world weapon-mod pickup reads like "❄️ Cryo Rounds — freezes… (mod)".
      rows.push({ label: 'Mod', value: `${mod.icon} ${mod.name}` })
      rows.push({ label: 'Effect', value: mod.blurb })
      rows.push({ label: 'Rarity', value: pretty(mod.rarity) })
    } else {
      rows.push({ label: 'Item', value: `${itemName(e.pickup.itemId)}${e.pickup.qty > 1 ? ` ×${e.pickup.qty}` : ''}` })
      const wpn = WEAPONS[e.pickup.itemId]
      const heal = CONSUMABLES[e.pickup.itemId]?.heal
      if (wpn) rows.push({ label: 'Damage', value: String(wpn.damage) })
      else if (heal) rows.push({ label: 'Heal', value: String(heal) })
    }
  }

  if (e.interact) rows.push({ label: 'Interact', value: pretty(e.interact.verb) })

  return { title, rows }
}
