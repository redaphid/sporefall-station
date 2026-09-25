// COMPLEX DIRECTOR — the indoor event AI for station-complex floors (3+).
//
// The city floors get their tension from open streets and roaming packs; the
// complex gets it from the building itself. A small, deterministic director
// watches the party and stages three kinds of set-piece:
//
//   - VENT SWARM: a vent grate a short walk from a player bursts and a knot of
//     sporelings crawls out, already hunting that player. Throttled, and capped
//     by how many earlier swarm-things are still alive, so it pressures a slow
//     party without snowballing.
//   - BUNK AMBUSH: the dormant sleepers seeded into a crew-quarters module
//     (populate.spawnComplexSleepers) all rise the moment a player steps inside
//     that room. Once per room.
//   - LIGHTS OUT: the wing a player is standing in loses power for a while.
//     Everything dormant in that wing stirs in the dark; the renderer dims the
//     wing from the `lightsOut`/`lightsOn` events (so net clients see it too).
//
// Determinism: only tick counters, the world's host sim rng (`w.rng`) and
// ascending-index scans. The director's schedule lives in `w.director`, which
// serializes (serialize.ts) so a mid-floor snapshot replays byte-identically.
// City floors never create it and never draw from the rng here.

import type { Entity } from '../entity'
import { storeyOf } from '../stairs'
import type { Level, Wing } from '../levelgen/level'
import { spawnNpc } from '../populate'
import { vlen } from '../simMath'
import { SIM_RATE, type EntityId } from '../types'
import { emitNoise, type World } from '../world'

/** First vent swarm no earlier than this many ticks into the floor. */
export const VENT_FIRST_TICKS = 25 * SIM_RATE
/** Gap between swarms, drawn per swarm (ticks, inclusive). */
export const VENT_GAP_TICKS: [number, number] = [20 * SIM_RATE, 35 * SIM_RATE]
/** When no vent qualifies, look again after this many ticks (no rng draw). */
export const VENT_RETRY_TICKS = 5 * SIM_RATE
/** A vent is eligible when the nearest living player is within this band:
 * close enough to matter, far enough that the swarm is seen coming. */
export const VENT_MIN_DIST = 6
export const VENT_MAX_DIST = 16
/** First lights-out no earlier than this many ticks into the floor. */
export const LIGHTS_FIRST_TICKS = 60 * SIM_RATE
export const LIGHTS_GAP_TICKS: [number, number] = [45 * SIM_RATE, 75 * SIM_RATE]
/** How long a wing stays dark. */
export const LIGHTS_OUT_TICKS = 12 * SIM_RATE
/** A player in a corridor still "owns" a wing whose wall is this close (tiles);
 * corridors are 2-3 wide, so every corridor tile borders some wing. */
export const LIGHTS_WING_REACH = 4

/** Director schedule + memory for the current complex floor. Plain JSON. */
export interface DirectorState {
  /** Floor this state was built for — a floor change rebuilds it. */
  floor: number
  nextVentAt: number
  nextLightsAt: number
  /** The currently dark wing (index into `level.complex.wings`), if any. */
  dark?: { wing: number; until: number }
  /** Building indices whose bunk ambush has already been sprung. */
  ambushed: number[]
  /** Ids of swarm-things this director spawned (pruned as they die). */
  spawned: EntityId[]
}

/** Swarm size for a floor: 2 on floor 3, growing slowly, capped at 5. */
export const swarmSize = (floor: number): number => Math.min(5, 2 + Math.floor((floor - 1) / 3))

/** Live director spawns allowed before vents stay shut. */
export const swarmCap = (floor: number): number => 4 + floor

/** Players the director plays against. Only the ground storey: vents, bunk
 * ambushes and wing blackouts are all ground-storey machinery (Phase 1 lofts
 * hold no enemies), so a player upstairs is left alone. */
const livingPlayers = (w: World): Entity[] => w.entities.filter((e) => e.playerCtl && !e.dead && storeyOf(e.pos.x) === 0)

const inRect = (r: { x: number; y: number; w: number; h: number }, x: number, y: number): boolean =>
  x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h

/** Build the fresh schedule for a complex floor (no rng — pure of the tick). */
const initDirector = (w: World): DirectorState => ({
  floor: w.floor,
  nextVentAt: w.tick + VENT_FIRST_TICKS,
  nextLightsAt: w.tick + LIGHTS_FIRST_TICKS,
  ambushed: [],
  spawned: [],
})

/** Wake one dormant body now, pointed at `target` when given. */
const rouse = (w: World, e: Entity, by: string, target?: Entity): void => {
  e.ai!.dormant = false
  e.ai!.mode = 'aggro'
  e.ai!.thinkAt = w.tick
  if (target) {
    e.ai!.targetId = target.id
    e.ai!.lastKnownTargetPos = { x: target.pos.x, y: target.pos.y }
  }
  w.events.push({ type: 'woke', entityId: e.id, by })
}

// ── Bunk ambush ──────────────────────────────────────────────────────────────

const ambushSystem = (w: World, d: DirectorState, players: Entity[]): void => {
  const { buildings } = w.level
  for (const p of players) {
    const tx = Math.floor(p.pos.x)
    const ty = Math.floor(p.pos.y)
    for (let bi = 0; bi < buildings.length; bi++) {
      const b = buildings[bi]
      if (b.role !== 'quarters' || d.ambushed.includes(bi)) continue
      if (!b.rooms.some((r) => inRect(r, tx, ty))) continue
      d.ambushed.push(bi)
      let count = 0
      for (const e of w.entities) {
        if (e.dead || !e.ai?.dormant || e.ai.zone?.building !== bi) continue
        rouse(w, e, 'ambush', p)
        count++
      }
      if (count > 0) {
        const room = b.rooms[0]
        w.events.push({ type: 'ambush', building: bi, count, x: room.x + room.w / 2, y: room.y + room.h / 2 })
      }
    }
  }
}

// ── Vent swarm ───────────────────────────────────────────────────────────────

/** Vents whose nearest living player sits inside the eligible distance band,
 * paired with that player. Vent order (generator order) is preserved. */
export const eligibleVents = (w: World, players: Entity[]): { x: number; y: number; target: Entity }[] => {
  const out: { x: number; y: number; target: Entity }[] = []
  for (const v of w.level.complex?.vents ?? []) {
    const cx = v.x + 0.5
    const cy = v.y + 0.5
    let best: Entity | undefined
    let bestD = Infinity
    for (const p of players) {
      const dd = vlen(p.pos.x - cx, p.pos.y - cy)
      if (dd < bestD) {
        bestD = dd
        best = p
      }
    }
    if (best && bestD >= VENT_MIN_DIST && bestD <= VENT_MAX_DIST) out.push({ x: cx, y: cy, target: best })
  }
  return out
}

/** Fixed fan-out offsets (tiles) — a table, not trig, so every peer agrees. */
const SWARM_FAN: readonly [number, number][] = [
  [0.3, 0],
  [-0.3, 0],
  [0, 0.3],
  [0, -0.3],
  [0, 0],
]

const ventSystem = (w: World, d: DirectorState, players: Entity[]): void => {
  if (w.tick < d.nextVentAt) return
  d.spawned = d.spawned.filter((id) => {
    const e = w.byId.get(id)
    return e !== undefined && !e.dead
  })
  const n = swarmSize(w.floor)
  const vents = d.spawned.length + n <= swarmCap(w.floor) ? eligibleVents(w, players) : []
  if (vents.length === 0) {
    d.nextVentAt = w.tick + VENT_RETRY_TICKS
    return
  }
  const vent = vents[w.rng.int(0, vents.length - 1)]
  for (let i = 0; i < n; i++) {
    // Fan the swarm out a little around the grate so bodies never stack.
    const [ox, oy] = SWARM_FAN[i % SWARM_FAN.length]
    const e = spawnNpc(w, 'sporeling', vent.x + ox, vent.y + oy)
    e.ai!.mode = 'aggro'
    e.ai!.targetId = vent.target.id
    e.ai!.lastKnownTargetPos = { x: vent.target.pos.x, y: vent.target.pos.y }
    e.ai!.thinkAt = w.tick
    d.spawned.push(e.id)
  }
  emitNoise(w, vent.x, vent.y)
  w.events.push({ type: 'ventSwarm', x: vent.x, y: vent.y, count: n, targetId: vent.target.id })
  d.nextVentAt = w.tick + w.rng.int(VENT_GAP_TICKS[0], VENT_GAP_TICKS[1])
}

// ── Lights out ───────────────────────────────────────────────────────────────

/** The wing a point is in, else the wing whose rect edge is nearest within
 * reach (lowest index on ties); -1 if none. */
export const wingForPoint = (level: Level, x: number, y: number): number => {
  const wings: Wing[] = level.complex?.wings ?? []
  for (let i = 0; i < wings.length; i++) if (inRect(wings[i].rect, x, y)) return i
  let best = -1
  let bestD = LIGHTS_WING_REACH
  for (let i = 0; i < wings.length; i++) {
    const r = wings[i].rect
    const dx = Math.max(r.x - x, 0, x - (r.x + r.w))
    const dy = Math.max(r.y - y, 0, y - (r.y + r.h))
    const dd = vlen(dx, dy)
    if (dd < bestD || (best < 0 && dd <= bestD)) {
      bestD = dd
      best = i
    }
  }
  return best
}

const lightsSystem = (w: World, d: DirectorState, players: Entity[]): void => {
  if (d.dark && w.tick >= d.dark.until) {
    w.events.push({ type: 'lightsOn', wing: d.dark.wing })
    d.dark = undefined
  }
  if (d.dark || w.tick < d.nextLightsAt) return
  const p = players[0] // lowest id living player: the director stalks the lead
  const wing = p ? wingForPoint(w.level, p.pos.x, p.pos.y) : -1
  if (wing < 0) {
    d.nextLightsAt = w.tick + VENT_RETRY_TICKS
    return
  }
  const until = w.tick + LIGHTS_OUT_TICKS
  d.dark = { wing, until }
  const rect = w.level.complex!.wings[wing].rect
  for (const e of w.entities) {
    if (e.dead || !e.ai?.dormant) continue
    if (!inRect(rect, e.pos.x, e.pos.y)) continue
    rouse(w, e, 'lightsOut')
  }
  w.events.push({ type: 'lightsOut', wing, until, x: rect.x, y: rect.y, w: rect.w, h: rect.h })
  d.nextLightsAt = until + w.rng.int(LIGHTS_GAP_TICKS[0], LIGHTS_GAP_TICKS[1])
}

/** Run the director for one tick. A no-op (and no rng draw) off complex floors
 * or once the run is over. */
export const complexDirectorSystem = (w: World): void => {
  if (!w.level.complex) {
    if (w.director) w.director = undefined
    return
  }
  if (w.gameOver) return
  if (!w.director || w.director.floor !== w.floor) w.director = initDirector(w)
  const d = w.director
  const players = livingPlayers(w)
  if (players.length === 0) return
  ambushSystem(w, d, players)
  ventSystem(w, d, players)
  lightsSystem(w, d, players)
}
