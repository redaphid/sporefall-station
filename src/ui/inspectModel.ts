// Pure builder for the tap/long-press inspect card — a friendly, per-kind
// readout of an entity (name/kind, hp, faction & stance, AI behavior + goal in
// plain words, door lock + pick time, item/weapon/mod stats, prop flavor,
// mission-target context). Kept DOM-free so the overlay just renders the card
// and tests assert on it exhaustively. Reads live entity fields plus the data
// tables for human-facing names; unknown/modded kinds fall back to enumerating
// the components actually present (the schema-reflection ethos) — never blank.

import type { AiState, Entity, ItemStack } from '../game/entity'
import { NPCS } from '../game/data/npcs'
import { OBJECTS } from '../game/data/objects'
import { CONSUMABLES, THROWABLES, WEAPONS } from '../game/data/items'
import { MODS } from '../game/data/mods'
import { BEHAVIORS, DEFAULT_BEHAVIOR } from '../game/systems/behaviors'
import { dispositionToward, initialPlayerHate, determineRel } from '../game/systems/relationships'
import { weaponStack } from '../game/systems/inventory'
import { pickTicks } from '../game/systems/interaction'
import { SIM_RATE } from '../game/types'

export interface InfoRow {
  label: string
  value: string
}

/** The full info card the overlay renders (chip = title+glyph+tagline subset). */
export interface InfoCard {
  /** Themed display name (see `nameFor` below). */
  title: string
  /** Entity kind, the friendly type line under the title. */
  kind: string
  archetype: string
  /** Renderer art key for the sprite thumbnail (door open/closed aware). */
  artKey: string
  /** Emoji stand-in when no texture thumbnail is available. */
  glyph: string
  /** One plain-words line: what it's doing / what it does. */
  tagline?: string
  /** Health bar data (drawn as a bar, not a row). */
  hp?: { hp: number; max: number }
  rows: InfoRow[]
  /** Present when this entity is the live mission target — the card offers the
   * mission panel's camera-focus action for it. */
  mission?: { targetId: number }
  /** The entity died/despawned — the card shows this briefly, then closes. */
  destroyed?: boolean
}

/** The slice of view state the builder needs beyond the entity itself. */
export interface InfoCardCtx {
  /** Local player's entity id — NPC stance ("Hostile") is toward THIS player. */
  selfId?: number
  /** Current mission target entity id (RenderView.missionTargetId). */
  missionTargetId?: number
}

/** Title-case an archetype key like `door.wood` → `Door Wood`. */
const pretty = (s: string): string =>
  s
    .split(/[._-]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ')

/** Human name for whichever weapon/throwable/consumable id we can resolve. */
const itemName = (id: string): string =>
  id === 'briefcase'
    ? 'Specimen Canister'
    : (WEAPONS[id]?.name ?? THROWABLES[id]?.name ?? CONSUMABLES[id]?.name ?? pretty(id))

/** One row per weapon mod on a stack: "❄️ Cryo Rounds" → "×N". Empty for a
 * vanilla / absent stack, so an unmodded gun shows just the Weapon row. */
const modRows = (stack: ItemStack | undefined): InfoRow[] =>
  (stack?.mods ?? [])
    .filter((m) => MODS[m.id] && m.stacks > 0)
    .map((m) => ({ label: `${MODS[m.id].icon} ${MODS[m.id].name}`, value: `×${m.stacks}` }))

// ---------------------------------------------------------------------------
// AI state → plain words. Goal codes come from goals.ts/behaviors.ts; the
// mode is the coarse fallback for AIs that predate goal arbitration.

const GOAL_PHRASE: Record<string, string> = {
  battle: 'Fighting',
  pursue: 'Hunting a target',
  flee: 'Running away',
  investigate: 'Investigating a disturbance',
  wander: 'Wandering around',
  search: 'Sweeping the area for a lost target',
  alert: 'Running to warn a guard',
  scavenge: 'Collecting loot',
}

const MODE_PHRASE: Record<string, string> = {
  idle: 'Standing around',
  wander: 'Wandering around',
  patrol: 'Walking a beat',
  aggro: 'Attacking',
  flee: 'Running away',
  seek: 'Heading somewhere',
  sleep: 'Asleep',
}

/** The NPC's current activity in plain words, e.g.
 * "Patrolling · heading to waypoint 3". Exported for exhaustive testing. */
export const aiPhrase = (ai: AiState): string => {
  if (ai.goal === 'patrol') return `Patrolling · heading to waypoint ${(ai.patrolIndex ?? 0) + 1}`
  if (ai.goal) return GOAL_PHRASE[ai.goal] ?? pretty(ai.goal)
  if (ai.mode === 'idle' && ai.guard) return 'Standing guard'
  return MODE_PHRASE[ai.mode] ?? pretty(ai.mode)
}

/** Innate temperament from the NPC table, human-phrased. */
const hostilityPhrase = (archetype: string): string | undefined => {
  const def = NPCS[archetype]
  if (!def) return undefined
  if (def.hostility === 'always') return 'Attacks on sight'
  if (def.hostility === 'lawful') return 'Attacks lawbreakers'
  return def.retaliates ? 'Peaceful — hits back' : 'Peaceful'
}

// ---------------------------------------------------------------------------
// Reflection fallback: fields every entity carries (never worth a row) vs the
// optional components that make an unknown entity legible.

const BASE_KEYS = new Set([
  'id', 'kind', 'archetype', 'pos', 'prevPos', 'vel', 'intent', 'speed', 'radius', 'facing', 'dead', 'selected',
])

/** Compact one-line summary of a component's value for the fallback card. */
const summarize = (v: unknown): string => {
  if (v === true) return 'Yes'
  if (v === false) return 'No'
  if (typeof v === 'number') return String(Math.round(v * 100) / 100)
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return `${v.length} entries`
  if (typeof v === 'object' && v !== null) {
    const parts = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean')
      .slice(0, 3)
      .map(([k, x]) => `${k} ${String(x)}`)
    return parts.length > 0 ? parts.join(' · ') : `${Object.keys(v).length} fields`
  }
  return String(v)
}

/** Enumerate the notable components an unfamiliar entity carries — the card is
 * never blank, even for modded kinds this UI has never heard of. */
const reflectionRows = (e: Entity): InfoRow[] => {
  const rows: InfoRow[] = [{ label: 'At', value: `${Math.round(e.pos.x)}, ${Math.round(e.pos.y)}` }]
  for (const [k, v] of Object.entries(e)) {
    if (BASE_KEYS.has(k) || v === undefined) continue
    rows.push({ label: pretty(k), value: summarize(v) })
  }
  return rows
}

/** How a throwable's landing effect reads to a player. */
const areaPhrase = (t: (typeof THROWABLES)[string]): string => {
  const a = t.onLand
  if (a.kind === 'fire') return 'Starts a fire where it lands'
  if (a.kind === 'explode') return `Explodes where it lands (${a.damage} damage)`
  return `Inflicts ${pretty(a.status)} where it lands`
}

/**
 * Build the friendly info card for an entity. Only rows that apply are emitted,
 * so a plain prop shows a short card and a rich NPC a fuller one; an entity no
 * section recognizes falls back to component reflection. Never throws — every
 * lookup is defensive.
 *
 * `nameFor` maps an archetype to its display name — the overlay passes the
 * theme-aware resolver (a `cop` can read "Bog Warden" in a swamp theme; same
 * sim entity, themed presentation). Defaults to plain title-casing so the
 * builder stays pure and theme-free for tests.
 */
export const buildInfoCard = (e: Entity, ctx: InfoCardCtx = {}, nameFor: (archetype: string) => string = pretty): InfoCard => {
  const rows: InfoRow[] = []
  const card: InfoCard = {
    title: nameFor(e.archetype),
    kind: e.kind,
    archetype: e.archetype,
    artKey: e.door ? (e.door.open ? 'door.open' : e.door.locked ? 'door.locked' : 'door') : e.archetype,
    glyph: GLYPHS[e.kind] ?? '❓',
    rows,
  }

  if (e.health) card.hp = { hp: Math.max(0, Math.round(e.health.hp)), max: e.health.max }

  if (e.dead) {
    card.destroyed = true
    card.tagline = 'Destroyed'
    return card
  }

  if (ctx.missionTargetId !== undefined && e.id === ctx.missionTargetId) card.mission = { targetId: e.id }

  if (e.ai) {
    card.tagline = aiPhrase(e.ai)
    const def = NPCS[e.archetype]
    rows.push({ label: 'Faction', value: pretty(e.ai.faction ?? def?.faction ?? 'neutral') })
    // Stance toward the local player: this NPC's stored opinion, else the
    // faction-derived opening stance — "will it come after ME?"
    const stance =
      ctx.selfId !== undefined ? dispositionToward(e, ctx.selfId) : determineRel(initialPlayerHate(e.ai.faction))
    rows.push({ label: 'Toward you', value: stance })
    const temper = hostilityPhrase(e.archetype)
    if (temper) rows.push({ label: 'Nature', value: temper })
    // Which pluggable brain is running (non-default only — 'basic' is implied).
    if (e.ai.behavior && e.ai.behavior !== DEFAULT_BEHAVIOR && BEHAVIORS[e.ai.behavior])
      rows.push({ label: 'Brain', value: pretty(e.ai.behavior) })
  }

  if (e.playerCtl) {
    rows.push({ label: 'Player', value: `P${e.playerCtl.playerId + 1}` })
    if (e.playerCtl.downed) card.tagline = 'Downed — needs a revive'
  }

  if (e.door) {
    rows.push({ label: 'Door', value: e.door.open ? 'Open' : e.door.locked ? `Locked (L${e.door.lockLevel})` : 'Closed' })
    if (!e.door.open && e.door.locked)
      rows.push({ label: 'Pick time', value: `${(pickTicks(e.door.lockLevel) / SIM_RATE).toFixed(1)}s` })
    card.tagline ??= e.door.open ? 'Walk on through' : e.door.locked ? 'Locked — Use starts the pick (stand still), or blast it open' : 'Closed — opens on use'
  }

  // Anyone who can hold a weapon — an NPC via `combat.weapon`, a player via the
  // equipped slot — gets a Weapon line so you can see what's pointed at you. Bare
  // fists (or a missing weapon) read as "Unarmed" rather than the "Fists" item
  // name or a blank. Mods on the equipped gun are surfaced for whoever carries
  // them (weaponStack is empty for NPCs, whose weapons are vanilla today), so an
  // NPC's build would be as legible as a player's (#41/#51).
  if (e.combat) {
    const wid = e.combat.weapon
    rows.push({ label: 'Weapon', value: wid && wid !== 'fists' ? itemName(wid) : 'Unarmed' })
    for (const r of modRows(weaponStack(e))) rows.push(r)
  }

  if (e.pickup) {
    const mod = MODS[e.pickup.itemId]
    const wpn = WEAPONS[e.pickup.itemId]
    const thr = THROWABLES[e.pickup.itemId]
    const con = CONSUMABLES[e.pickup.itemId]
    if (mod) {
      // A world weapon-mod pickup reads like "❄️ Cryo Rounds — freezes… (mod)".
      rows.push({ label: 'Mod', value: `${mod.icon} ${mod.name}` })
      rows.push({ label: 'Rarity', value: pretty(mod.rarity) })
      card.tagline = mod.blurb
    } else {
      rows.push({ label: 'Item', value: `${itemName(e.pickup.itemId)}${e.pickup.qty > 1 ? ` ×${e.pickup.qty}` : ''}` })
      if (wpn) {
        rows.push({ label: 'Damage', value: String(wpn.damage) })
        rows.push({ label: 'Range', value: `${wpn.range} tiles` })
        card.tagline = wpn.kind === 'ranged' ? 'Firearm — aim to shoot' : 'Melee weapon — swing it'
      } else if (thr) {
        card.tagline = areaPhrase(thr)
      } else if (con?.heal) {
        rows.push({ label: 'Heal', value: String(con.heal) })
        card.tagline = 'Use it to patch up'
      } else if (e.pickup.itemId === 'briefcase') {
        card.tagline = 'The specimen canister — this is what you came for'
      }
    }
  }

  // Interactive / destructible world object (crate, barrel, ATM, vending, …).
  const obj = OBJECTS[e.archetype]
  if (obj) {
    if (obj.use) rows.push({ label: 'Dispenses', value: itemName(obj.use.gives) })
    if (e.used) rows.push({ label: 'State', value: 'Already used' })
    if (obj.explode) card.tagline = 'Explosive — keep your distance'
    else if (obj.loot) card.tagline ??= 'Might drop something if broken'
    else if (obj.flammable) card.tagline ??= 'Flammable'
  }

  if (e.fire) {
    rows.push({ label: 'Fuel', value: String(e.fire.fuel) })
    card.tagline = 'Burning — stay clear'
  }

  if (e.projectile) {
    rows.push({ label: 'Damage', value: String(e.projectile.damage) })
    card.tagline ??= 'Incoming fire'
  }

  if (e.interact) rows.push({ label: 'Interact', value: pretty(e.interact.verb) })

  // Nothing recognized this entity → reflection fallback (modded/unknown kinds
  // still get a useful card, never a blank one).
  if (rows.length === 0 && !card.tagline) {
    card.tagline = 'Unknown object'
    rows.push(...reflectionRows(e))
  }

  return card
}

const GLYPHS: Record<string, string> = {
  player: '🙂',
  npc: '👤',
  pickup: '🎁',
  door: '🚪',
  interactable: '📦',
  fire: '🔥',
  projectile: '💨',
}
