// THE GROUP LAYER — raids ("tides"), hound packs and hive infestations.
//
// Everything else in the AI is per-body: each NPC scores its own considerations
// (behaviors.ts) and acts. That is enough for a mob, and it is why a mob reads as
// a mob. RimWorld's raids read as an ENEMY instead because a layer above the
// individual owns the shared decisions — when to go, where to gather, who is
// the officer, when the nerve breaks — and the individuals execute them.
//
// This module is that layer. It owns `World.groups` (plain JSON, serialized), a
// per-tick `groupSystem` that advances each group's PHASE and applies the
// group-wide effects (rally aura, heal pulses, lobbed shells, sapper charges,
// manhunter rage, hive growth), and the spawners. Members carry only
// `ai.group = {id, role}`; their brains read the group's phase/target/rally
// point through the considerations in behaviors.ts. Nothing here steers a body.
//
// Mechanics (docs/design/enemy-groups.md):
//   RAID STRATEGIES  assault (sporefall drop, immediate), staging (gather out of
//                    sight, then go TOGETHER), siege (a mortar battery shells you
//                    from range, escorts guard it), sappers (a breacher blows
//                    locked hatches so the raid comes THROUGH, not around).
//   COMMAND & MORALE a leader's bell rallies members in earshot; kill it — or
//                    cut down half the raid — and the survivors rout and flee.
//   RETREAT TO HEAL  wounded members fall back to the medic, get patched, return.
//   ENCIRCLEMENT     a hound pack spreads to a ring around its prey, then closes.
//   MANHUNTER RAGE   hurt one hound and its pack (and packs in earshot) berserk.
//   INFESTATION      hive spires bud sporelings and plant new spires over time.
//
// Determinism: only tick counters, ascending-id scans and STATELESS forks of
// the run seed (`groupRng`) — never `w.rng`, so adding a raid to a floor does not
// re-roll a single existing AI/loot die. City worlds built without populate (the
// test fixtures) have no `w.groups` at all and never enter this module.

import { BODY_RADIUS, makeEntity, type Entity, type GroupRole } from '../entity'
import { isSolidTile } from '../levelgen/level'
import { hasLineOfSight } from '../los'
import { findPath } from '../path'
import { spawnNpc } from '../populate'
import { hashLabel, mulberry32, type Rng } from '../rng'
import { vlen } from '../simMath'
import { bodySpawnPoint } from '../spawnPlacement'
import { SIM_RATE, type EntityId, type Vec2 } from '../types'
import { addEntity, emitNoise, type World } from '../world'
import { detonate } from './combat'
import { canSeeEntity, perceives } from './goals'

// ── State ──────────────────────────────────────────────────────────────────

export type GroupKind = 'raid' | 'pack'
export type RaidStrategy = 'assault' | 'staging' | 'siege' | 'sappers'
/** Raid phases: staging → attack, siege → attack, sapping → attack, any → routed.
 * Pack phases: prowl → encircle → attack (→ prowl when the prey is lost). */
export type GroupPhase = 'staging' | 'siege' | 'sapping' | 'attack' | 'routed' | 'prowl' | 'encircle'

export interface GroupState {
  id: number
  kind: GroupKind
  strategy?: RaidStrategy
  phase: GroupPhase
  /** Tick the current phase began. */
  since: number
  /** Members at muster — the morale denominator. */
  size: number
  /** Staging point / arrival point / pack den. */
  rally: Vec2
  /** The player this group is after. */
  targetId?: EntityId
  /** Group INTEL: the last fix on the target, refreshed on a cadence (raids) or
   * whenever a member sees it (packs) — never a live psychic feed. */
  mark?: Vec2
  markAt?: number
  /** Mustered with a leader — its death is a morale break. */
  hadLeader?: boolean
  /** Sappers: the door being blown, the tile the sapper plants it from (the
   * last step of its route before the door — the frame on ITS side), and the
   * tick the planted charge goes off. */
  doorId?: EntityId
  face?: Vec2
  chargeAt?: number
  /** Pack: the ring's approach bearing, fixed when the encirclement starts. */
  ringBase?: number
  /** Pack: manhunter until this tick. */
  rageUntil?: number
}

/** The floor's raid schedule. */
export interface TideState {
  nextAt: number
  sent: number
  max: number
}

export interface GroupsState {
  seq: number
  list: GroupState[]
  tide?: TideState
}

// ── Tuning ─────────────────────────────────────────────────────────────────

const S = SIM_RATE
/** Raid intel refresh: the group's shared fix on its target is this stale at worst. */
export const INTEL_TICKS = 3 * S
/** Staging: everyone within this of the rally point = gathered. */
export const STAGE_RADIUS = 3
/** Staging gives up waiting for stragglers after this long and goes anyway. */
export const STAGE_MAX_TICKS = 14 * S
/** Siege turns into an assault after this long. */
export const SIEGE_MAX_TICKS = 30 * S
/** A player this close to a siege gun breaks the siege: everyone attacks. */
export const SIEGE_BREAK = 6
/** Morale: routed once this fraction of the muster is dead (raids of 3+). */
export const ROUT_FRAC = 0.5
/** Routed members still out of every player's sight this long after the rout
 * dissolve back into the swamp (the echo pops, no drop). */
export const ROUT_DISSOLVE_TICKS = 6 * S
/** How far a player can be and still "see" a routed member (keeps it alive). */
export const ROUT_WATCH = 14
/** Leader aura. */
export const RALLY_RADIUS = 6
const RALLY_LINGER = 10
/** Retreat-to-heal thresholds (fraction of max hp). */
export const RETREAT_FRAC = 0.4
export const RETURN_FRAC = 0.8
/** Medic heal pulse. */
export const HEAL_INTERVAL = S
export const HEAL_RANGE = 2.2
export const healAmount = (floor: number): number => 7 + floor
/** Siege gun. */
export const LOB_MIN = 4
export const LOB_MAX = 14
export const LOB_INTERVAL = Math.round(3.5 * S)
export const LOB_SCATTER = 1.2
export const LOB_RADIUS = 1.7
export const LOB_SPEED = 8
export const lobDamage = (floor: number): number => 16 + 2 * floor
/** Sappers. */
export const PLANT_RANGE = 1.5
export const FUSE_TICKS = Math.round(1.6 * S)
export const SAPPER_BLAST_RADIUS = 1.1
export const SAPPER_BLAST_DAMAGE = 30
/** Pack encirclement. */
export const RING_RADIUS = 3
export const RING_TOL = 1.3
export const RING_MAX_TICKS = 4 * S
/** A pack that has not seen its prey this long goes back to prowling. */
export const PACK_LOSE_TICKS = 8 * S
/** Manhunter rage. */
export const RAGE_TICKS = 20 * S
export const HOWL_RADIUS = 14
/** Hive spires. */
export const HIVE_BROOD = 3
export const HIVE_WAKE = 16
export const HIVE_SPAWN_TICKS = 8 * S
export const HIVE_RETRY_TICKS = 2 * S
export const HIVE_SPREAD_TICKS = 30 * S
export const HIVE_SPREAD_WAKE = 28
export const hiveCap = (floor: number): number => Math.min(5, 2 + Math.floor(floor / 2))
/** Tides. */
export const TIDE_FIRST_TICKS = 32 * S
export const TIDE_GAP_TICKS: [number, number] = [40 * S, 60 * S]
export const TIDE_RETRY_TICKS = 5 * S
/** Live raiders allowed on a floor before the next tide waits (snapshot budget). */
export const RAID_LIVE_CAP = 12
export const tideCount = (floor: number): number => (floor < 2 ? 0 : Math.min(3, 1 + Math.floor((floor - 1) / 2)))
export const raidSize = (floor: number): number => Math.min(8, 2 + floor)

// ── Small helpers ──────────────────────────────────────────────────────────

const d2 = (a: Vec2, b: Vec2): number => vlen(a.x - b.x, a.y - b.y)

/** A stateless, per-decision random stream: a fork of the RUN seed by label.
 * Never `w.rng` — the sim stream must not move because a raid exists. */
export const groupRng = (w: World, label: string): Rng => mulberry32(hashLabel(w.seed, `groups:${w.floor}:${label}`))

export const livePlayers = (w: World): Entity[] =>
  w.entities.filter((e) => e.playerCtl && !e.dead && !e.playerCtl.downed)

const nearestOf = (list: Entity[], at: Vec2): Entity | undefined => {
  let best: Entity | undefined
  let bd = Infinity
  for (const e of list) {
    const d = d2(e.pos, at)
    if (d < bd) {
      bd = d
      best = e
    }
  }
  return best
}

export const centroid = (members: readonly Entity[]): Vec2 => {
  let x = 0
  let y = 0
  for (const m of members) {
    x += m.pos.x
    y += m.pos.y
  }
  const n = members.length || 1
  return { x: x / n, y: y / n }
}

export const groupById = (w: World, id: number | undefined): GroupState | undefined =>
  id === undefined ? undefined : w.groups?.list.find((g) => g.id === id)

export const groupOf = (w: World, e: Entity): GroupState | undefined => groupById(w, e.ai?.group?.id)

/** Live members of group `id`, ascending id (entities are id-ordered). */
export const membersOf = (w: World, id: number): Entity[] =>
  w.entities.filter((m) => !m.dead && m.ai?.group?.id === id)

export const roleOf = (e: Entity): GroupRole | undefined => e.ai?.group?.role

const ensureGroups = (w: World): GroupsState => (w.groups ??= { seq: 0, list: [] })

const newGroup = (w: World, init: Omit<GroupState, 'id'>): GroupState => {
  const gs = ensureGroups(w)
  const g: GroupState = { id: ++gs.seq, ...init }
  gs.list.push(g)
  return g
}

const setPhase = (w: World, g: GroupState, phase: GroupPhase, members: readonly Entity[]): void => {
  if (g.phase === phase) return
  w.events.push({ type: 'groupPhase', groupId: g.id, phase, prev: g.phase })
  g.phase = phase
  g.since = w.tick
  // Everyone re-decides THIS tick: a staged raid goes as one, not in a ripple
  // across the members' staggered think windows.
  for (const m of members) m.ai!.thinkAt = w.tick
}

/** Is a live body (not a projectile/pickup) standing on this spot? */
const bodyAt = (w: World, x: number, y: number): boolean => {
  for (const e of w.entities) {
    if (e.dead || e.projectile || e.pickup) continue
    const rr = e.radius + BODY_RADIUS
    const dx = e.pos.x - x
    const dy = e.pos.y - y
    if (dx * dx + dy * dy < rr * rr) return true
  }
  return false
}

/** Somewhere a body really fits near (x,y), preferring an unoccupied spot. */
const standAt = (w: World, x: number, y: number): Vec2 | null =>
  bodySpawnPoint(w.level, x, y, BODY_RADIUS, (px, py) => bodyAt(w, px, py))

/** Fixed fan-out around a muster point — a table, not trig, so peers agree. */
const FAN: readonly [number, number][] = [
  [0, 0],
  [1.2, 0],
  [-1.2, 0],
  [0, 1.2],
  [0, -1.2],
  [1.2, 1.2],
  [-1.2, -1.2],
  [1.2, -1.2],
  [-1.2, 1.2],
]

// ── Spawning ───────────────────────────────────────────────────────────────

const ROLE_ARCH: Record<GroupRole, string> = {
  leader: 'bellwether',
  grunt: 'drowner',
  medic: 'mender',
  sapper: 'breacher',
  artillery: 'lobber',
  hound: 'gloamhound',
}

/** The muster for a raid: specialists by strategy + depth, grunts to fill. */
export const raidRoster = (strategy: RaidStrategy, floor: number): GroupRole[] => {
  const out: GroupRole[] = []
  if (strategy === 'siege') {
    out.push('artillery')
    if (floor >= 5) out.push('artillery')
  }
  if (strategy === 'sappers') out.push('sapper')
  if (strategy === 'staging' || floor >= 4) out.push('leader')
  if ((strategy === 'staging' && floor >= 3) || (strategy === 'sappers' && floor >= 4) || floor >= 6) out.push('medic')
  const n = Math.max(raidSize(floor), out.length)
  while (out.length < n) out.push('grunt')
  return out
}

/** Which strategies a floor can roll. Depth unlocks the nastier ones. */
export const strategiesFor = (floor: number): RaidStrategy[] => {
  const s: RaidStrategy[] = ['assault', 'staging']
  if (floor >= 3) s.push('sappers')
  if (floor >= 4) s.push('siege')
  return s
}

/** Arrival band (tiles from the target) per strategy. An assault DROPS in close
 * (the sporefall exhales it in front of you); the rest walk in from out of
 * sight so their approach — the staging, the emplacement — can be seen coming. */
const ARRIVAL_BAND: Record<RaidStrategy, [number, number]> = {
  assault: [6, 9],
  staging: [14, 22],
  siege: [15, 21],
  sappers: [10, 22],
}

/** BFS distances (in steps) over walkable tiles from (tx,ty), out to `maxSteps`.
 * `throughLocked` lets the flood cross locked/overgrown doors (a sapper's reach).
 * Closed unlocked doors are always crossable (anyone opens them). */
const flood = (w: World, tx: number, ty: number, maxSteps: number, throughLocked: boolean): Int16Array => {
  const lw = w.level.w
  const lh = w.level.h
  const dist = new Int16Array(lw * lh).fill(-1)
  const locked = new Set<number>()
  if (!throughLocked) {
    for (const d of w.entities) {
      if (!d.door || d.dead || d.door.open) continue
      if (d.door.locked || d.door.overgrown) locked.add(Math.floor(d.pos.y) * lw + Math.floor(d.pos.x))
    }
  }
  if (isSolidTile(w.level, tx, ty)) return dist
  const q: number[] = [ty * lw + tx]
  dist[ty * lw + tx] = 0
  for (let qi = 0; qi < q.length; qi++) {
    const k = q[qi]
    const cd = dist[k]
    if (cd >= maxSteps) continue
    const x = k % lw
    const y = (k - x) / lw
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= lw || ny >= lh) continue
      const nk = ny * lw + nx
      if (dist[nk] !== -1 || isSolidTile(w.level, nx, ny) || locked.has(nk)) continue
      dist[nk] = cd + 1
      q.push(nk)
    }
  }
  return dist
}

/** Pick where a raid arrives: a walkable tile in the strategy's distance band
 * that the raid can actually walk to the target from, preferring one the target
 * cannot see (and, for sappers, one sealed off behind a locked hatch — the whole
 * point of bringing a breacher). Null when the floor offers nowhere. */
export const findArrival = (w: World, strategy: RaidStrategy, target: Entity, rng: Rng): Vec2 | null => {
  const [lo, hi] = ARRIVAL_BAND[strategy]
  const lw = w.level.w
  const tx = Math.floor(target.pos.x)
  const ty = Math.floor(target.pos.y)
  const steps = hi * 3
  const open = flood(w, tx, ty, steps, false)
  const reach = strategy === 'sappers' ? flood(w, tx, ty, steps, true) : open
  const hidden: number[] = []
  const behindDoor: number[] = []
  const seen: number[] = []
  for (let k = 0; k < reach.length; k++) {
    if (reach[k] < 0) continue
    const x = k % lw
    const y = (k - x) / lw
    const d = vlen(x + 0.5 - target.pos.x, y + 0.5 - target.pos.y)
    if (d < lo || d > hi) continue
    if (bodyAt(w, x + 0.5, y + 0.5)) continue
    if (strategy === 'sappers' && open[k] < 0) {
      behindDoor.push(k)
      continue
    }
    if (hasLineOfSight(w.level, target.pos.x, target.pos.y, x + 0.5, y + 0.5)) seen.push(k)
    else hidden.push(k)
  }
  // A drop is meant to be SEEN landing; everyone else would rather not be.
  const pools = strategy === 'assault' ? [seen, hidden] : strategy === 'sappers' ? [behindDoor, hidden, seen] : [hidden, seen]
  for (const pool of pools) {
    if (pool.length === 0) continue
    const k = pool[rng.int(0, pool.length - 1)]
    const x = k % lw
    return { x: x + 0.5, y: (k - x) / lw + 0.5 }
  }
  return null
}

/** Where a staging raid's members turn up: walkable, unoccupied tiles 5-9 steps
 * from the rally point that the target cannot see, drawn without repeats. */
const musterSpots = (w: World, rally: Vec2, target: Entity, n: number, rng: Rng): Vec2[] => {
  const lw = w.level.w
  const d = flood(w, Math.floor(rally.x), Math.floor(rally.y), 9, false)
  const pool: number[] = []
  for (let k = 0; k < d.length; k++) {
    if (d[k] < 5) continue
    const x = k % lw
    const y = (k - x) / lw
    if (bodyAt(w, x + 0.5, y + 0.5)) continue
    if (hasLineOfSight(w.level, target.pos.x, target.pos.y, x + 0.5, y + 0.5)) continue
    pool.push(k)
  }
  const out: Vec2[] = []
  for (let i = 0; i < n - 1 && pool.length > 0; i++) {
    const k = pool.splice(rng.int(0, pool.length - 1), 1)[0]
    const x = k % lw
    out.push({ x: x + 0.5, y: (k - x) / lw + 0.5 })
  }
  return out
}

/** Muster a raid of `strategy` against `target` at `at`. Members spawn fanned
 * around the arrival point; the group starts in the strategy's opening phase. */
export const spawnRaid = (
  w: World,
  strategy: RaidStrategy,
  at: Vec2,
  target: Entity,
  roster: readonly GroupRole[] = raidRoster(strategy, w.floor),
): GroupState => {
  const phase: GroupPhase =
    strategy === 'staging' ? 'staging' : strategy === 'siege' ? 'siege' : strategy === 'sappers' ? 'sapping' : 'attack'
  const g = newGroup(w, {
    kind: 'raid',
    strategy,
    phase,
    since: w.tick,
    size: 0,
    rally: { x: at.x, y: at.y },
    targetId: target.id,
    mark: { x: target.pos.x, y: target.pos.y },
    markAt: w.tick,
  })
  // A staging raid does not arrive in a knot — it trickles in from across the
  // area and GATHERS, which is the part worth seeing. (Fanned round the rally
  // point like the others, it counted as gathered on its first tick and
  // "staging" was a one-tick formality.)
  const scatter = strategy === 'staging' ? musterSpots(w, at, target, roster.length, groupRng(w, `muster:${g.id}`)) : []
  let n = 0
  for (let i = 0; i < roster.length; i++) {
    const [ox, oy] = FAN[i % FAN.length]
    const ring = 1 + Math.floor(i / FAN.length)
    const spot = i > 0 && scatter[i - 1] ? scatter[i - 1] : standAt(w, at.x + ox * ring, at.y + oy * ring)
    if (!spot) continue
    const role = roster[i]
    const e = spawnNpc(w, ROLE_ARCH[role], spot.x, spot.y)
    e.ai!.group = { id: g.id, role }
    e.ai!.thinkAt = w.tick
    if (role === 'leader') g.hadLeader = true
    if (strategy === 'assault') {
      // Dropped in on top of you: they already know where you are.
      e.ai!.mode = 'aggro'
      e.ai!.targetId = target.id
      e.ai!.lastKnownTargetPos = { x: target.pos.x, y: target.pos.y }
    }
    n++
  }
  g.size = n
  emitNoise(w, at.x, at.y)
  w.events.push({ type: 'raidArrive', groupId: g.id, strategy, x: at.x, y: at.y, count: n, targetId: target.id })
  return g
}

/** A hound pack denned at `den`: `n` hounds, prowling. */
export const spawnPack = (w: World, den: Vec2, n: number): GroupState | null => {
  const g = newGroup(w, { kind: 'pack', phase: 'prowl', since: w.tick, size: 0, rally: { x: den.x, y: den.y } })
  let placed = 0
  for (let i = 0; i < n; i++) {
    const [ox, oy] = FAN[i % FAN.length]
    const spot = standAt(w, den.x + ox, den.y + oy)
    if (!spot) continue
    const e = spawnNpc(w, 'gloamhound', spot.x, spot.y)
    e.ai!.group = { id: g.id, role: 'hound' }
    e.ai!.home = { x: den.x, y: den.y }
    placed++
  }
  g.size = placed
  return placed > 0 ? g : null
}

/** A hive spire rooted at (x,y), its infestation clock starting now. */
export const spawnHive = (w: World, x: number, y: number): Entity => {
  const e = spawnNpc(w, 'hivespire', x, y)
  e.ai!.guard = true // rooted: never ambles (and never draws a wander die)
  e.hive = { nextSpawnAt: w.tick + HIVE_RETRY_TICKS, nextSpreadAt: w.tick + HIVE_SPREAD_TICKS, children: [] }
  return e
}

/** Arm this floor's raid schedule (populate calls it; floor 1 gets none). */
export const initTides = (w: World): void => {
  const max = tideCount(w.floor)
  if (max <= 0) return
  const r = groupRng(w, 'tide-first')
  ensureGroups(w).tide = { nextAt: w.tick + TIDE_FIRST_TICKS + r.int(0, 10 * S), sent: 0, max }
}

// ── The system ─────────────────────────────────────────────────────────────

export const groupSystem = (w: World): void => {
  // Hives are entity-local (an `e.hive` clock), so they run even on a world
  // that never mustered a group (a hand-placed spire in a scenario or test).
  hiveSystem(w)
  const gs = w.groups
  if (!gs || w.gameOver) return
  tideSystem(w, gs)
  for (let i = 0; i < gs.list.length; i++) {
    const g = gs.list[i]
    const members = membersOf(w, g.id)
    if (members.length === 0) {
      gs.list.splice(i--, 1) // disbanded: every member dead or dissolved
      continue
    }
    if (g.kind === 'raid') updateRaid(w, g, members)
    else updatePack(w, g, members)
  }
}

const tideSystem = (w: World, gs: GroupsState): void => {
  const t = gs.tide
  if (!t || t.sent >= t.max || w.tick < t.nextAt) return
  const players = livePlayers(w)
  let raiders = 0
  for (const e of w.entities) if (!e.dead && e.ai?.group && groupById(w, e.ai.group.id)?.kind === 'raid') raiders++
  if (players.length === 0 || raiders >= RAID_LIVE_CAP) {
    t.nextAt = w.tick + TIDE_RETRY_TICKS
    return
  }
  const r = groupRng(w, `tide:${t.sent}:${t.nextAt}`)
  const options = strategiesFor(w.floor)
  const strategy = options[r.int(0, options.length - 1)]
  const target = players[r.int(0, players.length - 1)]
  const at = findArrival(w, strategy, target, r)
  if (!at) {
    t.nextAt = w.tick + TIDE_RETRY_TICKS
    return
  }
  spawnRaid(w, strategy, at, target)
  t.sent++
  t.nextAt = w.tick + r.int(TIDE_GAP_TICKS[0], TIDE_GAP_TICKS[1])
}

// ── Raids ──────────────────────────────────────────────────────────────────

const updateRaid = (w: World, g: GroupState, members: Entity[]): void => {
  const players = livePlayers(w)
  // Target upkeep: a downed/dead/missing focus hands over to the nearest live player.
  let target = g.targetId !== undefined ? w.byId.get(g.targetId) : undefined
  if (!target || target.dead || target.playerCtl?.downed) {
    target = nearestOf(players, centroid(members))
    g.targetId = target?.id
    if (target) g.markAt = undefined // force a fresh fix on the new focus
  }
  if (target && (g.markAt === undefined || w.tick - g.markAt >= INTEL_TICKS)) {
    g.mark = { x: target.pos.x, y: target.pos.y }
    g.markAt = w.tick
  }

  if (g.phase === 'routed') {
    dissolveRouted(w, g, members, players)
    return
  }

  // ── Morale ──
  const leader = members.find((m) => roleOf(m) === 'leader')
  const lost = g.size - members.length
  const reason = g.hadLeader && !leader ? 'leader' : g.size >= 3 && lost >= g.size * ROUT_FRAC ? 'casualties' : undefined
  if (reason) {
    const c = centroid(members)
    w.events.push({ type: 'raidRouted', groupId: g.id, reason, x: c.x, y: c.y, count: members.length })
    for (const m of members) {
      m.ai!.healing = undefined
      m.ai!.rallyUntil = undefined
    }
    setPhase(w, g, 'routed', members)
    return
  }

  // ── Command: the leader's bell rallies everyone in earshot ──
  if (leader) {
    for (const m of members) {
      if (m === leader) continue
      if (d2(m.pos, leader.pos) <= RALLY_RADIUS) m.ai!.rallyUntil = w.tick + RALLY_LINGER
    }
  }

  // ── Retreat to heal ──
  const medics = members.filter((m) => roleOf(m) === 'medic')
  for (const m of members) {
    if (roleOf(m) === 'medic' || !m.health) continue
    const frac = m.health.hp / m.health.max
    if (medics.length === 0) m.ai!.healing = undefined
    else if (frac < RETREAT_FRAC) m.ai!.healing = true
    else if (m.ai!.healing && frac >= RETURN_FRAC) m.ai!.healing = undefined
  }
  if (medics.length > 0 && (w.tick - g.since) % HEAL_INTERVAL === 0) {
    for (const medic of medics) healPulse(w, medic, members)
  }

  // ── Phase ──
  if (g.phase === 'staging') {
    const gathered = members.every((m) => d2(m.pos, g.rally) <= STAGE_RADIUS)
    const spotted = players.some((p) => members.some((m) => perceives(w, m, p)))
    if (gathered || spotted || w.tick - g.since >= STAGE_MAX_TICKS) setPhase(w, g, 'attack', members)
  } else if (g.phase === 'siege') {
    const guns = members.filter((m) => roleOf(m) === 'artillery')
    const rushed = players.some((p) => guns.some((a) => d2(a.pos, p.pos) <= SIEGE_BREAK))
    if (guns.length === 0 || rushed || w.tick - g.since >= SIEGE_MAX_TICKS) setPhase(w, g, 'attack', members)
  } else if (g.phase === 'sapping') {
    updateSappers(w, g, members, target)
  }

  // ── The siege gun fires in siege AND once the assault is on ──
  if (target) for (const m of members) if (roleOf(m) === 'artillery') lob(w, g, m, members, target)
}

const dissolveRouted = (w: World, g: GroupState, members: Entity[], players: Entity[]): void => {
  if (w.tick - g.since < ROUT_DISSOLVE_TICKS) return
  for (const m of members) {
    const watched = players.some((p) => d2(p.pos, m.pos) <= ROUT_WATCH && canSeeEntity(w, p, m))
    if (watched) continue
    m.dead = true
    w.events.push({ type: 'dissolve', entityId: m.id, x: m.pos.x, y: m.pos.y })
  }
}

/** One heal pulse from `medic`: the most-hurt member within reach gets patched. */
const healPulse = (w: World, medic: Entity, members: Entity[]): void => {
  let best: Entity | undefined
  let bestFrac = 1
  for (const m of members) {
    if (m === medic || !m.health) continue
    if (d2(m.pos, medic.pos) > HEAL_RANGE) continue
    const frac = m.health.hp / m.health.max
    if (frac < bestFrac) {
      bestFrac = frac
      best = m
    }
  }
  if (!best?.health) return
  const before = best.health.hp
  best.health.hp = Math.min(best.health.max, best.health.hp + healAmount(w.floor))
  w.events.push({ type: 'heal', entityId: best.id, byId: medic.id, amount: best.health.hp - before })
}

/** The first locked/overgrown hatch on the sapper's route to the target, and
 * the route tile just before it (where the sapper stands to plant), if any. */
export const nextSealedDoor = (w: World, from: Entity, to: Vec2): { door: Entity; face: Vec2 } | undefined => {
  const lw = w.level.w
  const passable = new Set<number>()
  const sealed = new Map<number, Entity>()
  for (const d of w.entities) {
    if (!d.door || d.dead || d.door.open) continue
    const k = Math.floor(d.pos.y) * lw + Math.floor(d.pos.x)
    passable.add(k) // a sapper treats EVERY door as a way through
    if (d.door.locked || d.door.overgrown) sealed.set(k, d)
  }
  if (sealed.size === 0) return undefined
  const nodes = findPath(w.level, from.pos.x, from.pos.y, to.x, to.y, { closedDoors: passable })
  if (!nodes) return undefined
  for (let i = 0; i < nodes.length; i++) {
    const d = sealed.get(Math.floor(nodes[i].y) * lw + Math.floor(nodes[i].x))
    if (!d) continue
    const prev = i > 0 ? nodes[i - 1] : from.pos
    return { door: d, face: { x: Math.floor(prev.x) + 0.5, y: Math.floor(prev.y) + 0.5 } }
  }
  return undefined
}

const updateSappers = (w: World, g: GroupState, members: Entity[], target: Entity | undefined): void => {
  const sapper = members.find((m) => roleOf(m) === 'sapper')
  // A planted charge goes off whether or not its sapper lived to see it.
  if (g.chargeAt !== undefined && w.tick >= g.chargeAt) {
    const door = g.doorId !== undefined ? w.byId.get(g.doorId) : undefined
    if (door?.door && !door.dead && !door.door.open) {
      detonate(w, door.pos.x, door.pos.y, SAPPER_BLAST_RADIUS, SAPPER_BLAST_DAMAGE, sapper?.id ?? 0)
    }
    g.chargeAt = undefined
    g.doorId = undefined
    g.face = undefined
  }
  if (g.chargeAt !== undefined) return // fuse burning: everyone clears the blast
  if (!sapper || !target || !g.mark) {
    setPhase(w, g, 'attack', members)
    return
  }
  let door = g.doorId !== undefined ? w.byId.get(g.doorId) : undefined
  if (!door?.door || door.dead || door.door.open || !(door.door.locked || door.door.overgrown)) {
    const next = nextSealedDoor(w, sapper, g.mark)
    door = next?.door
    g.doorId = next?.door.id
    g.face = next?.face
  }
  if (!door) {
    setPhase(w, g, 'attack', members) // nothing sealed between us and them: go
    return
  }
  if (d2(sapper.pos, door.pos) <= PLANT_RANGE) {
    g.chargeAt = w.tick + FUSE_TICKS
    w.events.push({ type: 'sapperCharge', entityId: sapper.id, doorId: door.id, x: door.pos.x, y: door.pos.y, fuse: FUSE_TICKS })
    for (const m of members) m.ai!.thinkAt = w.tick // clear the blast NOW
  }
}

/** The siege gun: a shell lobbed over everything at the raid's fix on the
 * target — only when some member actually SEES it (a spotter), in range, and
 * off cooldown. Aim scatter is a stateless fork, not the sim stream. */
const lob = (w: World, g: GroupState, gun: Entity, members: Entity[], target: Entity): void => {
  if (w.tick < (gun.ai!.lobAt ?? 0)) return
  if (g.phase === 'routed') return
  if (!members.some((m) => perceives(w, m, target))) return
  const d = d2(gun.pos, target.pos)
  if (d < LOB_MIN || d > LOB_MAX) return
  const r = groupRng(w, `lob:${gun.id}:${w.tick}`)
  const tx = target.pos.x + (r.next() - 0.5) * 2 * LOB_SCATTER
  const ty = target.pos.y + (r.next() - 0.5) * 2 * LOB_SCATTER
  const dist = d2(gun.pos, { x: tx, y: ty }) || 1
  const ticks = Math.max(24, Math.min(60, Math.round((dist / LOB_SPEED) * S)))
  const shell = makeEntity('projectile', 'grenade', gun.pos.x, gun.pos.y, 0.15)
  shell.vel.x = ((tx - gun.pos.x) / ticks) * S
  shell.vel.y = ((ty - gun.pos.y) / ticks) * S
  shell.facing = Math.atan2(ty - gun.pos.y, tx - gun.pos.x)
  shell.projectile = {
    ownerId: gun.id,
    damage: 0,
    ttl: ticks,
    onLand: { kind: 'explode', radius: LOB_RADIUS, damage: lobDamage(w.floor) },
    arc: true,
  }
  addEntity(w, shell)
  gun.facing = shell.facing
  gun.ai!.lobAt = w.tick + LOB_INTERVAL
  emitNoise(w, gun.pos.x, gun.pos.y)
  w.events.push({ type: 'lob', entityId: gun.id, x: gun.pos.x, y: gun.pos.y, tx, ty, ticks })
}

// ── Packs ──────────────────────────────────────────────────────────────────

/** Turn pack `g` manhunter against `p`; a howl carries to packs in earshot. */
const enrage = (w: World, g: GroupState, p: Entity, howl: boolean): void => {
  const members = membersOf(w, g.id)
  if (members.length === 0) return
  const fresh = g.rageUntil === undefined || w.tick >= g.rageUntil
  g.rageUntil = w.tick + RAGE_TICKS
  g.targetId = p.id
  g.mark = { x: p.pos.x, y: p.pos.y }
  g.markAt = w.tick
  for (const m of members) m.ai!.rageUntil = g.rageUntil
  if (fresh) {
    const c = centroid(members)
    w.events.push({ type: 'packRage', groupId: g.id, targetId: p.id, x: c.x, y: c.y, count: members.length })
  }
  setPhase(w, g, 'attack', members)
  if (!howl) return
  const here = centroid(members)
  for (const other of w.groups?.list ?? []) {
    if (other === g || other.kind !== 'pack') continue
    const om = membersOf(w, other.id)
    if (om.length === 0 || d2(centroid(om), here) > HOWL_RADIUS) continue
    enrage(w, other, p, false) // a howl answers a howl only once
  }
}

/** Where hound `m` stands in its pack's ring around `target`. Slot 0 sits on the
 * side the pack came from; the rest are spread evenly round the circle, so the
 * prey ends up with a hound on every side. A slot inside a wall pulls in toward
 * the prey until it fits (a ring in a corridor is a tight one). */
export const ringSlot = (w: World, g: GroupState, members: readonly Entity[], m: Entity, target: Entity): Vec2 => {
  const k = Math.max(0, members.indexOf(m))
  const n = Math.max(1, members.length)
  const base = g.ringBase ?? 0
  const ang = base + (2 * Math.PI * k) / n
  for (const r of [RING_RADIUS, RING_RADIUS * 0.7, RING_RADIUS * 0.45]) {
    const x = target.pos.x + Math.cos(ang) * r
    const y = target.pos.y + Math.sin(ang) * r
    if (!isSolidTile(w.level, Math.floor(x), Math.floor(y))) return { x, y }
  }
  return { x: target.pos.x, y: target.pos.y }
}

const updatePack = (w: World, g: GroupState, members: Entity[]): void => {
  const players = livePlayers(w)
  // Provocation: a player's landed blow on ANY hound turns the pack manhunter.
  for (const m of members) {
    const by = m.ai!.provokedBy
    if (by === undefined) continue
    m.ai!.provokedBy = undefined
    const p = w.byId.get(by)
    if (p?.playerCtl && !p.dead && !p.playerCtl.downed) enrage(w, g, p, true)
  }
  const raging = g.rageUntil !== undefined && w.tick < g.rageUntil
  if (g.rageUntil !== undefined && !raging) {
    g.rageUntil = undefined
    for (const m of members) m.ai!.rageUntil = undefined
  }

  let target = g.targetId !== undefined ? w.byId.get(g.targetId) : undefined
  if (target && (target.dead || target.playerCtl?.downed)) target = undefined
  if (!target && raging) target = nearestOf(players, centroid(members))
  g.targetId = target?.id
  if (target && members.some((m) => perceives(w, m, target))) {
    g.mark = { x: target.pos.x, y: target.pos.y }
    g.markAt = w.tick
  }

  if (g.phase === 'prowl') {
    for (const p of players) {
      if (!members.some((m) => perceives(w, m, p))) continue
      g.targetId = p.id
      g.mark = { x: p.pos.x, y: p.pos.y }
      g.markAt = w.tick
      const c = centroid(members)
      g.ringBase = Math.atan2(c.y - p.pos.y, c.x - p.pos.x)
      w.events.push({ type: 'packHunt', groupId: g.id, targetId: p.id, count: members.length })
      setPhase(w, g, 'encircle', members)
      return
    }
    return
  }
  if (!target) {
    setPhase(w, g, 'prowl', members)
    return
  }
  if (g.phase === 'encircle') {
    const closed = members.every((m) => d2(m.pos, ringSlot(w, g, members, m, target)) <= RING_TOL)
    if (closed || w.tick - g.since >= RING_MAX_TICKS) {
      w.events.push({ type: 'packClose', groupId: g.id, targetId: target.id, closed })
      setPhase(w, g, 'attack', members)
    }
    return
  }
  // attack: a pack that has lost its prey for long enough goes back to prowling.
  if (!raging && (g.markAt === undefined || w.tick - g.markAt > PACK_LOSE_TICKS)) {
    g.targetId = undefined
    setPhase(w, g, 'prowl', members)
  }
}

// ── Hives ──────────────────────────────────────────────────────────────────

const HIVE_RING: readonly [number, number][] = [
  [1.3, 0],
  [-1.3, 0],
  [0, 1.3],
  [0, -1.3],
]

/** A spot 4-7 tiles from `spire` where a new spire can root: walkable, free of
 * bodies, and not right on top of a player. Deterministic scan order. */
const spreadSpot = (w: World, spire: Entity, players: Entity[]): Vec2 | null => {
  const r = groupRng(w, `spread:${spire.id}:${w.tick}`)
  const start = r.int(0, 7)
  for (const rad of [5, 4, 6, 7]) {
    for (let i = 0; i < 8; i++) {
      const ang = ((start + i) % 8) * (Math.PI / 4)
      const x = Math.floor(spire.pos.x + Math.cos(ang) * rad) + 0.5
      const y = Math.floor(spire.pos.y + Math.sin(ang) * rad) + 0.5
      if (isSolidTile(w.level, Math.floor(x), Math.floor(y))) continue
      if (bodyAt(w, x, y)) continue
      if (players.some((p) => d2(p.pos, { x, y }) < 4)) continue
      return { x, y }
    }
  }
  return null
}

const hiveSystem = (w: World): void => {
  let spires: Entity[] | undefined
  for (const e of w.entities) {
    if (!e.hive || e.dead) continue
    ;(spires ??= []).push(e)
  }
  if (!spires) return
  const players = livePlayers(w)
  let count = spires.length
  for (const s of spires) {
    const h = s.hive!
    // (Rooted: movement.ts never lets a body with `hive` be shoved or knocked
    // back — speed 0 alone was measured letting its own buds jostle a spire
    // 5.5 tiles across the room.)
    h.children = h.children.filter((id) => {
      const c = w.byId.get(id)
      return c !== undefined && !c.dead
    })
    const near = nearestOf(players, s.pos)
    const nd = near ? d2(near.pos, s.pos) : Infinity
    if (w.tick >= h.nextSpawnAt) {
      if (near && nd <= HIVE_WAKE && h.children.length < HIVE_BROOD) {
        const [ox, oy] = HIVE_RING[h.children.length % HIVE_RING.length]
        const at = standAt(w, s.pos.x + ox, s.pos.y + oy) ?? s.pos
        const bud = spawnNpc(w, 'sporeling', at.x, at.y)
        bud.ai!.mode = 'aggro'
        bud.ai!.targetId = near.id
        bud.ai!.lastKnownTargetPos = { x: near.pos.x, y: near.pos.y }
        bud.ai!.thinkAt = w.tick
        h.children.push(bud.id)
        w.events.push({ type: 'hiveSpawn', entityId: bud.id, byId: s.id })
        h.nextSpawnAt = w.tick + HIVE_SPAWN_TICKS
      } else {
        h.nextSpawnAt = w.tick + HIVE_RETRY_TICKS
      }
    }
    if (w.tick >= h.nextSpreadAt) {
      h.nextSpreadAt = w.tick + HIVE_SPREAD_TICKS
      if (count < hiveCap(w.floor) && nd <= HIVE_SPREAD_WAKE) {
        const spot = spreadSpot(w, s, players)
        if (spot) {
          const sprout = spawnHive(w, spot.x, spot.y)
          // A young spire: half-grown, so an infestation caught early dies fast.
          sprout.health!.hp = Math.max(1, Math.round(sprout.health!.max / 2))
          count++
          w.events.push({ type: 'hiveSpread', entityId: sprout.id, byId: s.id, x: spot.x, y: spot.y })
        }
      }
    }
  }
}

// ── Floor population (populate.ts calls this last, on its own fork) ─────────

/** Hound packs on a floor: none on 1, one likely from 2, two from 5. */
export const packsFor = (floor: number, r: Rng): number =>
  floor < 2 ? 0 : floor >= 5 ? 2 : r.chance(floor >= 3 ? 0.8 : 0.6) ? 1 : 0
export const packSize = (floor: number): number => Math.min(5, 3 + Math.floor((floor - 2) / 2))
/** Hive spires rooted at floor start: none before 3, two from 6. */
export const hivesFor = (floor: number, r: Rng): number =>
  floor < 3 ? 0 : floor >= 6 ? 2 : r.chance(Math.min(0.85, 0.4 + 0.1 * floor)) ? 1 : 0
/** Packs den and hives root at least this far from the player's landing. */
export const GROUP_SPAWN_CLEARANCE = 17

/** A walkable, unoccupied tile centre at least `clear` tiles from the level
 * spawn (and off the exit pad), or null after a bounded number of draws. With
 * `indoors`, only tiles inside one of the level's building rooms count. */
const openSpot = (w: World, r: Rng, clear: number, indoors: boolean): Vec2 | null => {
  const { level } = w
  const ex = Math.floor(level.exit.x)
  const ey = Math.floor(level.exit.y)
  for (let attempt = 0; attempt < 60; attempt++) {
    let tx: number
    let ty: number
    if (indoors && level.buildings.length > 0) {
      const b = level.buildings[r.int(0, level.buildings.length - 1)]
      const room = b.rooms[r.int(0, b.rooms.length - 1)] ?? b.rect
      tx = r.int(room.x, room.x + room.w - 1)
      ty = r.int(room.y, room.y + room.h - 1)
    } else {
      tx = r.int(1, level.w - 2)
      ty = r.int(1, level.h - 2)
    }
    if (isSolidTile(level, tx, ty) || (tx === ex && ty === ey)) continue
    const x = tx + 0.5
    const y = ty + 0.5
    if (vlen(x - level.spawn.x, y - level.spawn.y) < clear) continue
    if (bodyAt(w, x, y)) continue
    return { x, y }
  }
  return null
}

/** Seed this floor's standing groups (hound packs, hive spires) and arm its raid
 * schedule. Runs on its OWN `groups` fork after every other populate stream, so
 * the existing layout/loot/AI dice are byte-identical per seed — only the
 * entity list grows. Floor 1 is left exactly as it was. */
export const populateGroups = (w: World): void => {
  if (w.floor < 2) return
  const r = w.rng.fork('groups')
  const packs = packsFor(w.floor, r)
  for (let i = 0; i < packs; i++) {
    const den = openSpot(w, r, GROUP_SPAWN_CLEARANCE, false)
    if (den) spawnPack(w, den, packSize(w.floor))
  }
  const hives = hivesFor(w.floor, r)
  for (let i = 0; i < hives; i++) {
    const at = openSpot(w, r, GROUP_SPAWN_CLEARANCE, true)
    if (at) spawnHive(w, at.x, at.y)
  }
  initTides(w)
}
