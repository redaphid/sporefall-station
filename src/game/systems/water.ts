// Water — the THIRD hazard cell, built on the same deterministic shape as
// `systems/fire.ts` and `systems/spore.ts`: a hazard cell is its own sim entity
// (kind 'fire', the non-colliding ground-hazard kind) addressed by the cell it
// sits in, at most one per cell, carrying `fuel` that decays 1/tick until it
// dries up. While it lasts it lays the `wet` element on any body standing in it.
//
// THE SIM NEVER MUTATES TILES (serialize.ts: the level is regenerable from
// seed+floor and `deserializeWorld` THROWS on a levelChecksum mismatch), so a
// flooded cell is an ENTITY, never a tile edit. That is also why this is the
// third instance of a shape that already had two rather than a new mechanism.
//
// ── Why water is STATIC, and fire/spore are not ────────────────────────────
// Fire spreads because combustion propagates: it eats a flammable and reaches
// for the next one. Spores spread because they are alive and blooming. Water on
// a flat deck has no motive force — a puddle is simply where it was spilled, and
// it only shrinks. So `waterSystem` has no spread pass at all. Three reasons,
// in order of how load-bearing they are:
//
//  1. THE SNAPSHOT BUDGET. Every hazard cell is an entity competing for
//     `SNAPSHOT_ENTITY_CAP = 48` (netHost.ts) against the actual enemies. Fire
//     and spore are self-limiting in ways water would not be: fire needs a
//     flammable neighbour to spread to, and a spore child inherits LESS fuel
//     than its parent so a bloom reaches a fixed radius and stops. A spreading
//     puddle has neither brake — the natural design ("Mirefather floods cells as
//     it moves") would lay down an unbounded slick and starve its own teammates'
//     snapshots. Static cells make the worst case exactly "what a caller asked
//     for", which MAX_WATER_CELLS then bounds outright.
//  2. IT IS A DECISION, NOT A TIMER. Fire and spore CHASE you — that is their
//     pressure. Water is terrain you choose to stand in. Conduction is
//     deliberately symmetric (a player in a puddle they are shooting into is
//     electrocuted too), and that is only fair if the hazard holds still long
//     enough to be read and stepped out of. A puddle that crawled after you
//     would remove the choice the friendly-fire rule rests on.
//  3. Spread is the expensive half of both other systems (the O(fires ×
//     flammables) probe). Water pays none of it.
//
// ── Fire + water in one cell: the water WINS, and pays for it ──────────────
// A deliberate call (see douseFires): the fire is extinguished outright and the
// water loses STEAM_COST fuel to the steam. Both sides are affected, so neither
// is a special case — an event loses to terrain, and the terrain is spent doing
// it. It also makes water a two-way lever rather than a one-way buff: flood a
// burning barricade to clear it, or burn a puddle off with an incendiary round
// to deny Mirefather the sheath it is standing in. The alternative ("steam")
// would need a fourth hazard type, a fourth wire archetype and a new element,
// to say something the doused fire already says.
//
// DETERMINISM: no randomness anywhere. Cells are created only by explicit
// `floodCell` calls, every pass walks `w.entities` in ascending id order, and
// NEIGHBORS is a frozen probe order shared with the shock-conduction flood
// (systems/interactions.ts) so "which way does the current travel first" has
// exactly one answer on every device and every replay.

import { ELEMENTS } from '../data/elements'
import { makeEntity, type Entity } from '../entity'
import { isSolidTile } from '../levelgen/level'
import { addEntity, type World } from '../world'
import { addStatus } from './statusFx'

/** Ticks a freshly-flooded cell lasts before it dries up (~15s at 30tps).
 * Longer than fire (360) and spore (240) on purpose: those two are EVENTS that
 * sweep through a room, water is TERRAIN you fight on top of. */
export const WATER_FUEL = 450

/** Fuel a cell loses for quenching a fire — the water boiled off as steam. At
 * WATER_FUEL / STEAM_COST it takes several fires to dry one cell out, so a
 * puddle can smother a spreading blaze but a sustained one still wins. */
export const STEAM_COST = 60

/**
 * Hard ceiling on LIVE water cells in one world. The snapshot budget is the
 * whole reason: `SNAPSHOT_ENTITY_CAP = 48` inside `INTEREST_RADIUS = 14`
 * (netHost.ts), and every cell of a puddle is one entity bidding for a slot
 * against the enemies actually trying to kill you. 24 is half that budget — big
 * enough for a 5×5 arena pool with room to spare, small enough that a flood can
 * never evict more than half the things a player needs to see.
 *
 * This is the same argument that pins Mireclaw's `MAX_BROOD = 8`, and it is
 * enforced HERE rather than trusted to callers, so a future boss that floods a
 * cell per step cannot quietly starve its teammates' snapshots.
 */
export const MAX_WATER_CELLS = 24

/** Fixed neighbour probe order — part of determinism, never reorder. Shared
 * with the shock-conduction flood so current travels cells in one fixed order.
 * Orthogonal only, exactly like fire and spore: a puddle connects through shared
 * EDGES, which makes a diagonal gap a real break a player can read and use. */
export const NEIGHBORS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

/** Is standing water occupying this cell? */
export const waterAt = (w: World, tx: number, ty: number): boolean => {
  for (const e of w.entities) {
    if (e.water && !e.dead && Math.floor(e.pos.x) === tx && Math.floor(e.pos.y) === ty) return true
  }
  return false
}

/** How many live water cells the world currently holds (the cap's counter). */
export const waterCellCount = (w: World): number => {
  let n = 0
  for (const e of w.entities) if (e.water && !e.dead) n++
  return n
}

/**
 * Flood one cell. One puddle per cell (an occupied cell is a no-op), never on a
 * wall, and never past MAX_WATER_CELLS — each refusal returns `undefined`, the
 * same contract `igniteCell`/`seedSpore` already use, so a caller that ignores
 * the result simply gets no cell rather than a broken one.
 */
export const floodCell = (w: World, tx: number, ty: number, fuel = WATER_FUEL): Entity | undefined => {
  if (isSolidTile(w.level, tx, ty)) return undefined
  if (waterAt(w, tx, ty)) return undefined
  if (waterCellCount(w) >= MAX_WATER_CELLS) return undefined
  const e = makeEntity('fire', 'water', tx + 0.5, ty + 0.5, 0.4)
  e.water = { fuel }
  return addEntity(w, e)
}

/** Flood the cell an entity is standing in (a boss laying its own ground, a
 * burst pipe, the debug verb). Mirrors `fire.ignite`. */
export const flood = (w: World, target: Entity): Entity | undefined =>
  floodCell(w, Math.floor(target.pos.x), Math.floor(target.pos.y))

/** Quench every fire standing in water, charging each puddle STEAM_COST for the
 * one it put out. Walks fires in ascending id order against a set of water cells
 * built once, so the fuel each cell is left holding is byte-identical per seed. */
const douseFires = (w: World, cells: Map<number, Entity>, lw: number): void => {
  for (const f of w.entities) {
    if (!f.fire || f.dead) continue
    const cell = cells.get(Math.floor(f.pos.y) * lw + Math.floor(f.pos.x))
    if (cell === undefined) continue
    f.dead = true
    cell.water!.fuel -= STEAM_COST
  }
}

/**
 * The water lifecycle each tick: QUENCH any fire sharing a cell, WET every body
 * standing in one, then DRY DOWN and evaporate.
 *
 * Runs AFTER fireSystem/sporeSystem in `tickWorld`, so a fire lit or spread into
 * a puddle this tick is already gone by the time `elementSystem` applies damage.
 *
 * PERF: the cell index is built ONCE per tick and probed in O(1) — the lesson
 * fire.ts already learned the hard way (its per-flammable `fireAt` was
 * O(bodies × entities) and dominated the frame on furnished floors). `waterAt`
 * stays available as the public one-shot probe; this pass never calls it.
 */
export const waterSystem = (w: World): void => {
  const waters = w.entities.filter((e) => e.water && !e.dead)
  if (waters.length === 0) return // every floor with no water pays nothing

  // Keyed exactly like the movement door grid: `ty*w + tx`, unique per in-bounds
  // tile. A cell is only ever created on an in-bounds open tile, so no negative
  // coordinate can collide into this key space.
  const lw = w.level.w
  const cells = new Map<number, Entity>()
  for (const e of waters) cells.set(Math.floor(e.pos.y) * lw + Math.floor(e.pos.x), e)

  douseFires(w, cells, lw)

  // Soak every body in a flooded cell. `!e.water` keeps the puddles from wetting
  // each other (a cell is an entity too), and the health check keeps `wet` on
  // things that can actually be hurt by what it enables — matching sporeSystem.
  // A DOWNED body is deliberately NOT exempt: it gets wet and it conducts, but
  // `shock` still refuses to damage it, so the protection lives in exactly one
  // place instead of being re-stated here.
  for (const e of w.entities) {
    if (e.dead || !e.health || e.water) continue
    if (!cells.has(Math.floor(e.pos.y) * lw + Math.floor(e.pos.x))) continue
    addStatus(w, e, 'wet', ELEMENTS.wet.durationTicks)
  }

  for (const e of waters) {
    e.water!.fuel -= 1
    if (e.water!.fuel <= 0) e.dead = true
  }
}
