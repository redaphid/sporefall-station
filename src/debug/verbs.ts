// The verb surface over the live ECS world — the single bridge every debug
// client (CLI, MCP, in-app channel) drives. `runVerb` is pure and synchronous:
// it takes a World and a verb line, mutates/reads it, and returns a text reply
// (usually JSON). Keeping it side-effect-free of any transport makes it unit-
// testable and lets the channel decide WHEN to run it (reads immediately,
// writes deferred onto the sim step).

import { makeEntity, type Entity } from '../game/entity'
import { NPCS } from '../game/data/npcs'
import { MODS, isModId, modMaxStacks } from '../game/data/mods'
import { weaponStack } from '../game/systems/inventory'
import { spawnNpc } from '../game/populate'
import { spawnPlayer } from '../game/player'
import { deserializeWorld, serializeWorld, type WorldJson } from '../game/serialize'
import { kill as killEntity } from '../game/systems/combat'
import { addAnnotations, clearAnnotations } from '../game/annotations'
import { selectedEntities } from '../game/select'
import type { SimEvent } from '../game/types'
import { addEntity, tickWorld, type World } from '../game/world'
import { decodeArg } from './protocol'

/** Verbs that mutate the world — the channel defers these onto the sim step so
 * they never land mid-render; reads answer immediately. `load`/`step`/`tick`
 * change or advance the whole world, so they are deferred too. */
export const WRITE_VERBS = new Set([
  'set',
  'spawn',
  'kill',
  'teleport',
  'load',
  'step',
  'tick',
  'annotate',
  'clearAnnotations',
  'addMod',
])

export interface VerbCtx {
  /** Channel-maintained ring of recent events (they are cleared from
   * `world.events` every tick). Falls back to the current tick's events. */
  events?: readonly SimEvent[]
  /** Presentation hook: hot-swap the active visual theme. Injected by whoever
   * owns a renderer (main.ts / the debug channel); themes are render-side only,
   * so the verb never touches the world and is a no-op in headless contexts. */
  setTheme?: (id: string) => void
}

/** The effective verb name, unwrapping the `command` escape hatch. */
export const verbName = (line: string): string => {
  const tokens = line.trim().split(/\s+/)
  return tokens[0] === 'command' ? (tokens[1] ?? '') : (tokens[0] ?? '')
}

/** A JSON-safe verbatim clone of an entity. Because entities are plain data,
 * this captures EVERY field — including components no debug tool knows about
 * yet, so new systems show up in the inspector for free. */
export const serializeEntity = (e: Entity): Record<string, unknown> =>
  JSON.parse(JSON.stringify(e)) as Record<string, unknown>

const num = (s: string | undefined, what: string): number => {
  const n = Number(s)
  if (!Number.isFinite(n)) throw new Error(`expected a number for ${what}, got "${s}"`)
  return n
}

const entity = (w: World, idStr: string | undefined): Entity => {
  const e = w.byId.get(num(idStr, 'entity id'))
  if (!e) throw new Error(`no entity with id ${idStr}`)
  return e
}

const coerce = (cur: unknown, next: unknown): unknown => {
  if (typeof cur === 'number' && typeof next === 'string' && next.trim() !== '' && Number.isFinite(Number(next)))
    return Number(next)
  if (typeof cur === 'boolean' && typeof next === 'string') return next === 'true'
  return next
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Keys that must never be written through a patch: assigning them (even by
 * recursing into the inherited object they resolve to) escapes the target and
 * poisons Object.prototype for the whole process. A debug surface takes
 * untrusted input, so this guard is non-negotiable. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Deep-merge a JSON patch into a target, coercing scalars to the target's
 * existing type. Nested objects merge; arrays and scalars replace. Dangerous
 * keys are skipped so a patch can never reach a prototype. */
const mergeInto = (target: Record<string, unknown>, patch: Record<string, unknown>): void => {
  for (const k of Object.keys(patch)) {
    if (FORBIDDEN_KEYS.has(k)) continue
    const pv = patch[k]
    const tv = target[k]
    if (isPlainObject(pv) && isPlainObject(tv)) mergeInto(tv, pv)
    else target[k] = coerce(tv, pv)
  }
}

const nextPlayerSlot = (w: World): number => {
  let max = -1
  for (const e of w.entities) if (e.playerCtl && e.playerCtl.playerId > max) max = e.playerCtl.playerId
  return max + 1
}

const spawn = (w: World, kind: string, archetype: string, x: number, y: number): Entity => {
  if (kind === 'npc' && NPCS[archetype]) return spawnNpc(w, archetype, x, y)
  if (kind === 'player') return spawnPlayer(w, nextPlayerSlot(w), x, y)
  // Generic fallback: bare entity so any kind can be materialized for a repro.
  return addEntity(w, makeEntity(kind as Entity['kind'], archetype, x, y))
}

const countByKind = (w: World): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const e of w.entities) counts[e.kind] = (counts[e.kind] ?? 0) + 1
  return counts
}

/** Reject a forbidden key ANYWHERE in an untrusted `load` payload. `deserialize`
 * already deep-clones through JSON so a prototype can't be reached, but a whole
 * world is a bigger blast radius than a `set` patch, so we fail loud and early
 * rather than trust the clone — the same non-negotiable guard `set` applies. */
const assertNoForbiddenKeys = (v: unknown): void => {
  if (Array.isArray(v)) {
    for (const x of v) assertNoForbiddenKeys(x)
  } else if (isPlainObject(v)) {
    for (const k of Object.keys(v)) {
      // JSON.parse surfaces `__proto__` as a real OWN enumerable key, so this
      // catches it (a plain `obj.__proto__` access never would).
      if (FORBIDDEN_KEYS.has(k)) throw new Error(`forbidden key "${k}" in load payload`)
      assertNoForbiddenKeys(v[k])
    }
  }
}

/** Replace a live world's contents in place so every closed-over reference (the
 * channel holds one) keeps pointing at the same object. World is a flat record,
 * so copying its own fields from a freshly-deserialized world is a full swap. */
const loadWorldInto = (target: World, fresh: World): void => {
  Object.assign(target, fresh)
}

const jsonType = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

interface FieldSchema {
  /** How many entities carry this top-level field. */
  count: number
  /** The distinct JSON types seen for it (number/string/boolean/object/array/null). */
  types: string[]
  /** For object-valued components, the union of nested sub-field names seen. */
  keys?: string[]
}

/** Derive the component/archetype shape of the world from its LIVE entities — no
 * hardcoded field list to rot as systems come and go. For every entity we walk
 * its verbatim JSON (so unknown/future components are counted for free) and
 * tally which top-level fields exist, their types, and one level of sub-keys. */
const buildSchema = (w: World): {
  entityCount: number
  kinds: Record<string, number>
  archetypes: Record<string, { kind: string; count: number }>
  fields: Record<string, FieldSchema>
} => {
  const kinds: Record<string, number> = {}
  const archetypes: Record<string, { kind: string; count: number }> = {}
  const acc: Record<string, { count: number; types: Set<string>; keys: Set<string> }> = {}
  for (const e of w.entities) {
    kinds[e.kind] = (kinds[e.kind] ?? 0) + 1
    const a = (archetypes[e.archetype] ??= { kind: e.kind, count: 0 })
    a.count++
    for (const [k, v] of Object.entries(serializeEntity(e))) {
      const f = (acc[k] ??= { count: 0, types: new Set(), keys: new Set() })
      f.count++
      f.types.add(jsonType(v))
      if (isPlainObject(v)) for (const sub of Object.keys(v)) f.keys.add(sub)
    }
  }
  const fields: Record<string, FieldSchema> = {}
  for (const [k, f] of Object.entries(acc)) {
    fields[k] = {
      count: f.count,
      types: [...f.types].sort(),
      ...(f.keys.size ? { keys: [...f.keys].sort() } : {}),
    }
  }
  return { entityCount: w.entities.length, kinds, archetypes, fields }
}

/** Run one verb line against the world and return a text reply. Throws on a bad
 * verb/argument; the transport turns that into an `ok:false` reply. */
export const runVerb = (w: World, line: string, ctx: VerbCtx = {}): string => {
  const trimmed = line.trim()
  const sp = trimmed.indexOf(' ')
  const verb = sp < 0 ? trimmed : trimmed.slice(0, sp)
  const rest = sp < 0 ? '' : trimmed.slice(sp + 1).trim()

  switch (verb) {
    case 'entities':
      // `entities` → all; `entities selected` → just the ones the player picked
      // (a plain, general filter — selection is normal ECS state, not a special
      // channel). Any other arg is rejected so typos fail loud.
      if (rest === 'selected') return JSON.stringify(selectedEntities(w.entities).map(serializeEntity))
      if (rest) throw new Error(`usage: entities [selected]`)
      return JSON.stringify(w.entities.map(serializeEntity))

    case 'get':
      return JSON.stringify(serializeEntity(entity(w, rest)))

    case 'set': {
      const idSp = rest.indexOf(' ')
      if (idSp < 0) throw new Error('usage: set <id> <jsonPatch>')
      const e = entity(w, rest.slice(0, idSp))
      const patch = JSON.parse(decodeArg(rest.slice(idSp + 1).trim())) as unknown
      // A patch is a merge of fields, so only an object makes sense. Reject
      // arrays/scalars/null up front — an array would splatter numeric-index
      // keys onto the entity, and `null` would blow up in Object.keys.
      if (!isPlainObject(patch)) throw new Error('set patch must be a JSON object')
      mergeInto(e as unknown as Record<string, unknown>, patch)
      return JSON.stringify(serializeEntity(e))
    }

    case 'spawn': {
      const [kind, archetype, xs, ys] = rest.split(/\s+/)
      if (!kind || !archetype) throw new Error('usage: spawn <kind> <archetype> <x> <y>')
      const e = spawn(w, kind, archetype, num(xs, 'x'), num(ys, 'y'))
      return JSON.stringify(serializeEntity(e))
    }

    case 'kill': {
      const e = entity(w, rest)
      killEntity(w, e)
      return JSON.stringify({ id: e.id, dead: !!e.dead, downed: !!e.playerCtl?.downed })
    }

    case 'teleport': {
      const [ids, xs, ys] = rest.split(/\s+/)
      const e = entity(w, ids)
      const x = num(xs, 'x')
      const y = num(ys, 'y')
      e.pos.x = x
      e.pos.y = y
      e.prevPos.x = x // clear interpolation so it doesn't streak across the map
      e.prevPos.y = y
      return JSON.stringify({ id: e.id, pos: e.pos })
    }

    case 'state':
      return JSON.stringify({
        tick: w.tick,
        seed: w.seed,
        floor: w.floor,
        alarm: w.alarm,
        gameOver: w.gameOver,
        mission: w.mission,
        counts: countByKind(w),
        total: w.entities.length,
        // General world UI state (not a special channel): which entities the player
        // has selected, and how many annotations are being drawn.
        selectedIds: selectedEntities(w.entities).map((e) => e.id),
        annotations: w.annotations.length,
      })

    case 'events':
      return JSON.stringify(ctx.events ?? w.events)

    case 'dump':
      // Lossless snapshot of the WHOLE world (serialize.ts, #47) — the exact JSON
      // `load` consumes for a byte-identical restore.
      return JSON.stringify(serializeWorld(w))

    case 'load': {
      // Restore an EXACT world from a `dump` snapshot, in place. Untrusted input,
      // so guard prototype keys before the deserializer ever touches it.
      if (!rest) throw new Error('usage: load <WorldJson>')
      const json = JSON.parse(decodeArg(rest)) as unknown
      if (!isPlainObject(json)) throw new Error('load payload must be a WorldJson object')
      assertNoForbiddenKeys(json)
      loadWorldInto(w, deserializeWorld(json as unknown as WorldJson))
      return JSON.stringify({ ok: true, tick: w.tick, seed: w.seed, floor: w.floor, total: w.entities.length })
    }

    case 'step':
    case 'tick': {
      // Advance the deterministic sim N ticks with NEUTRAL input (no player
      // commands) — the pure `(seed→RNG)+input` step, so the RNG stream is the
      // only entropy. Default 1.
      const n = rest ? num(rest, 'tick count') : 1
      if (!Number.isInteger(n) || n < 0) throw new Error(`step count must be a non-negative integer, got "${rest}"`)
      for (let i = 0; i < n; i++) tickWorld(w, new Map())
      return JSON.stringify({ tick: w.tick, advanced: n })
    }

    case 'schema':
      // Reflection: the live component/archetype shape of the world, derived from
      // its entities so unfamiliar/new components show up without a hardcoded list.
      return JSON.stringify(buildSchema(w))

    case 'annotate': {
      // Draw one or many inert on-screen annotations (game/types.ts `Annotation`).
      // Untrusted input: guard prototype keys before touching it (belt-and-suspenders
      // — sanitizeAnnotation also only reads whitelisted fields), then validate.
      if (!rest) throw new Error('usage: annotate <Annotation | Annotation[] JSON>')
      const parsed = JSON.parse(decodeArg(rest)) as unknown
      assertNoForbiddenKeys(parsed)
      const added = addAnnotations(w, parsed)
      return JSON.stringify({ added: added.length, ids: added.map((a) => a.id) })
    }

    case 'clearAnnotations': {
      // No arg → clear all; `clearAnnotations <id>` → clear one (numeric or string id).
      const id = rest === '' ? undefined : /^-?\d+(\.\d+)?$/.test(rest) ? Number(rest) : rest
      const removed = clearAnnotations(w, id)
      return JSON.stringify({ removed, remaining: w.annotations.length })
    }

    case 'addMod': {
      // Append (or stack) a weapon mod onto an entity's SLOTTED weapon — the
      // AI-native payoff: a registry-checked, stack-capped mutation of a modded
      // loadout over the channel. `addMod <id> <modId> [stacks]`.
      const [ids, modId, stacksStr] = rest.split(/\s+/)
      const e = entity(w, ids)
      if (!modId || !isModId(modId)) throw new Error(`unknown mod "${modId}" — known: ${Object.keys(MODS).sort().join(', ')}`)
      const stacks = stacksStr === undefined ? 1 : num(stacksStr, 'stacks')
      if (!Number.isInteger(stacks) || stacks < 1) throw new Error(`stacks must be a positive integer, got "${stacksStr}"`)
      const stack = weaponStack(e)
      if (!stack) throw new Error(`entity ${e.id} has no slotted weapon to mod (equip a ranged/melee weapon from inventory first)`)
      const cap = modMaxStacks(modId)
      const mods = (stack.mods ??= [])
      const existing = mods.find((m) => m.id === modId)
      if (existing) existing.stacks = Math.min(cap, existing.stacks + stacks)
      else mods.push({ id: modId, stacks: Math.min(cap, stacks) })
      return JSON.stringify({ id: e.id, weapon: e.combat?.weapon, mods: stack.mods })
    }

    case 'theme': {
      // Presentation-only: swaps the renderer's theme (sprites/palette/names).
      // Deliberately NOT a write verb — it never touches world state, so
      // determinism, serialization and replay are unaffected.
      if (!rest || rest.includes(' ')) throw new Error('usage: theme <themeId>')
      if (!/^[a-z0-9][a-z0-9-]*$/.test(rest)) throw new Error(`invalid theme id "${rest}" (lowercase [a-z0-9-])`)
      if (!ctx.setTheme) throw new Error('theme switching unavailable here (no renderer attached)')
      ctx.setTheme(rest)
      return JSON.stringify({ theme: rest, status: 'switching' })
    }

    case 'command':
      // Escape hatch: the rest of the line is itself a verb — run it verbatim.
      if (!rest) throw new Error('usage: command <verb ...>')
      return runVerb(w, rest, ctx)

    default:
      throw new Error(`unknown verb: ${verb}`)
  }
}
