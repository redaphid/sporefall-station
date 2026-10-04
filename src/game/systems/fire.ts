// Fire — the first element, end to end. A fire is a grid-cell hazard: its own
// sim entity (kind 'fire') addressed by the cell it sits in, at most one per
// cell. Each tick a fire licks at its four orthogonal neighbors and ignites any
// flammable object standing there (spread), sets `burning` on flammable things
// and creatures in its own cell, and burns its fuel down until it gutters out.
// The `burning` status then deals its damage-over-time generically via
// elementSystem, so a thing keeps burning after it walks out of the flames.
// Re-expressed from observed Streets of Rogue behavior, not ported.
// Deterministic: spread follows object positions in ascending entity-id order,
// no randomness.

import { ELEMENTS } from '../data/elements'
import { makeEntity, resistMult, type Entity, type EntityKind } from '../entity'
import { addEntity, type World } from '../world'
import { hurt, kill } from './combat'
import { applyStatus } from './statusFx'
import { vlen } from '../simMath'

/** Ticks a freshly-lit cell burns before guttering out (~12s at 30tps). */
const FUEL = 360

/** Fire creeps to a new neighbor every this-many ticks, not every frame — so
 * you watch it crawl down a row rather than flash across it. */
const SPREAD_INTERVAL = 18

/** Kinds that catch fire by standing in a burning cell even when not flammable
 * (#114: "fire should set creatures alight"). Drop 'player' to exempt players. */
const CREATURES: ReadonlySet<EntityKind> = new Set(['npc', 'player'])

/** Standing in a burning cell sets this alight: flammable things and every
 * creature, unless it is immune to burning (resist 0). */
const catchesFire = (e: Entity): boolean =>
  (e.flammable === true || CREATURES.has(e.kind)) && resistMult(e, 'burning') > 0

/** Gap (tiles) between a burning body and a flammable that still counts as touching. */
const BRUSH_SLACK = 0.1

/** Fixed neighbor probe order — part of determinism, never reorder. */
const NEIGHBORS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

/** Is any fire burning in this cell? */
export const fireAt = (w: World, tx: number, ty: number): boolean => {
  for (const e of w.entities) {
    if (e.fire && !e.dead && Math.floor(e.pos.x) === tx && Math.floor(e.pos.y) === ty) return true
  }
  return false
}

/** Light a cell. One fire per cell — an occupied cell is a no-op. */
export const igniteCell = (w: World, tx: number, ty: number): Entity | undefined => {
  if (fireAt(w, tx, ty)) return undefined
  const e = makeEntity('fire', 'fire', tx + 0.5, ty + 0.5, 0.4)
  e.fire = { fuel: FUEL }
  return addEntity(w, e)
}

/** Light the cell an entity stands in (barrel/`ignite` object, debug ignite). */
export const ignite = (w: World, target: Entity): Entity | undefined =>
  igniteCell(w, Math.floor(target.pos.x), Math.floor(target.pos.y))

/** The fire lifecycle each tick: SPREAD to flammable neighbors, IGNITE
 * flammable things and creatures in a burning cell, then BURN DOWN and
 * extinguish. Fires lit by spread this tick only probe their own neighbors next
 * tick. */
export const fireSystem = (w: World): void => {
  const fires = w.entities.filter((e) => e.fire && !e.dead)
  const flammables = w.entities.filter((e) => e.flammable && !e.dead)

  // Every burning cell, keyed `ty*w + tx` (unique per in-bounds tile) and kept
  // current as this tick lights more. An O(1) probe here replaces a full entity
  // scan (`fireAt`) per candidate, which a furnished floor (~100 flammables plus
  // its NPCs) would pay on every tick.
  const lw = w.level.w
  const cellOf = (e: Entity): number => Math.floor(e.pos.y) * lw + Math.floor(e.pos.x)
  const fireCells = new Set(fires.map(cellOf))
  const light = (tx: number, ty: number): void => {
    if (fireCells.has(ty * lw + tx)) return
    igniteCell(w, tx, ty)
    fireCells.add(ty * lw + tx)
  }

  if (w.tick % SPREAD_INTERVAL === 0) {
    for (const f of fires) {
      const fx = Math.floor(f.pos.x)
      const fy = Math.floor(f.pos.y)
      for (const t of flammables) {
        const tx = Math.floor(t.pos.x)
        const ty = Math.floor(t.pos.y)
        if (!NEIGHBORS.some(([dx, dy]) => fx + dx === tx && fy + dy === ty)) continue
        light(tx, ty)
      }
    }
  }

  // A burning NPC lights whatever flammable it brushes past, so a panicking
  // body carries the fire through the room it runs into.
  for (const b of w.entities) {
    if (b.dead || !b.ai || b.fx?.burning === undefined) continue
    for (const t of flammables) {
      if (t === b || vlen(t.pos.x - b.pos.x, t.pos.y - b.pos.y) > b.radius + t.radius + BRUSH_SLACK) continue
      light(Math.floor(t.pos.x), Math.floor(t.pos.y))
    }
  }

  // Whatever catches fire and stands in a burning cell is set alight, in ascending
  // id order. It lands through applyStatus with no source, exactly like a burning
  // round, so a wet body dries instead of catching and a lit NPC panics (#92).
  if (fireCells.size > 0) {
    for (const t of w.entities) {
      if (t.dead || !catchesFire(t) || !fireCells.has(cellOf(t))) continue
      applyStatus(w, t, 'burning', ELEMENTS.burning.durationTicks)
    }
  }

  for (const f of fires) {
    f.fire!.fuel -= 1
    if (f.fire!.fuel <= 0) f.dead = true
  }
}

/** The unit of `StatusEntry.prepaidMicroHp`. */
const MICRO_HP = 1_000_000

/** Generic per-tick element effects: any entity carrying an element with a
 * `dot` loses that hp each tick. Data-driven off ELEMENTS, so poisoned/etc.
 * light up for free once their behavior lands. */
export const elementSystem = (w: World): void => {
  for (const e of w.entities) {
    if (e.dead || !e.fx || !e.health) continue
    if (e.playerCtl?.downed) continue // a downed body is out of the fight — DOT can't re-kill it (#52)
    for (const kind of Object.keys(e.fx)) {
      const def = ELEMENTS[kind]
      if (!def || def.dot <= 0) continue
      if (w.tick % def.interval !== 0) continue
      // #78 damage affinity: a fireproof body barely feels burning; a flammable
      // one takes extra. Missing table → ×1 (unchanged DOT).
      const mult = resistMult(e, kind)
      if (mult <= 0) continue // immune (mult 0) — the status lingers but does no harm
      // hp is whole, so deal what this tick owes rounded up and bank the rest
      // against the next tick (#131). Rounding each tick alone made a cinder's
      // 0.4 a 0, and made a half resist on a 1-damage element no resist at all.
      // The ledger is in whole micro-hp: float remainders drift, and a drift of
      // 1e-16 above a whole number would round a whole extra hp up.
      const entry = e.fx[kind]
      const perTick = Math.max(1, Math.round(def.dot * mult * MICRO_HP)) // any resist above 0 owes something
      const owed = perTick - (entry.prepaidMicroHp ?? 0)
      const dmg = Math.ceil(owed / MICRO_HP)
      entry.prepaidMicroHp = dmg * MICRO_HP - owed || undefined
      if (dmg <= 0) continue
      hurt(w, e.health, dmg)
      w.events.push({ type: 'hit', x: e.pos.x, y: e.pos.y, targetId: e.id, amount: dmg })
      if (e.health.hp <= 0) {
        kill(w, e)
        break
      }
    }
  }
}
