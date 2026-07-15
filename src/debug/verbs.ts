// The verb surface over the live ECS world — the single bridge every debug
// client (CLI, MCP, in-app channel) drives. `runVerb` is pure and synchronous:
// it takes a World and a verb line, mutates/reads it, and returns a text reply
// (usually JSON). Keeping it side-effect-free of any transport makes it unit-
// testable and lets the channel decide WHEN to run it (reads immediately,
// writes deferred onto the sim step).

import { makeEntity, type Entity } from '../game/entity'
import { NPCS } from '../game/data/npcs'
import { spawnNpc } from '../game/populate'
import { spawnPlayer } from '../game/player'
import { kill as killEntity } from '../game/systems/combat'
import type { SimEvent } from '../game/types'
import { addEntity, type World } from '../game/world'
import { decodeArg } from './protocol'

/** Verbs that mutate the world — the channel defers these onto the sim step so
 * they never land mid-render; reads answer immediately. */
export const WRITE_VERBS = new Set(['set', 'spawn', 'kill', 'teleport'])

export interface VerbCtx {
  /** Channel-maintained ring of recent events (they are cleared from
   * `world.events` every tick). Falls back to the current tick's events. */
  events?: readonly SimEvent[]
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

/** Deep-merge a JSON patch into a target, coercing scalars to the target's
 * existing type. Nested objects merge; arrays and scalars replace. */
const mergeInto = (target: Record<string, unknown>, patch: Record<string, unknown>): void => {
  for (const k of Object.keys(patch)) {
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
  if (kind === 'player') return spawnPlayer(w, nextPlayerSlot(w), archetype, x, y)
  // Generic fallback: bare entity so any kind can be materialized for a repro.
  return addEntity(w, makeEntity(kind as Entity['kind'], archetype, x, y))
}

const countByKind = (w: World): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const e of w.entities) counts[e.kind] = (counts[e.kind] ?? 0) + 1
  return counts
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
      return JSON.stringify(w.entities.map(serializeEntity))

    case 'get':
      return JSON.stringify(serializeEntity(entity(w, rest)))

    case 'set': {
      const idSp = rest.indexOf(' ')
      if (idSp < 0) throw new Error('usage: set <id> <jsonPatch>')
      const e = entity(w, rest.slice(0, idSp))
      const patch = JSON.parse(decodeArg(rest.slice(idSp + 1).trim())) as Record<string, unknown>
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
      })

    case 'events':
      return JSON.stringify(ctx.events ?? w.events)

    case 'command':
      // Escape hatch: the rest of the line is itself a verb — run it verbatim.
      if (!rest) throw new Error('usage: command <verb ...>')
      return runVerb(w, rest, ctx)

    default:
      throw new Error(`unknown verb: ${verb}`)
  }
}
