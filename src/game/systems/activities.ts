// Ambient activities: props that advertise something to do. A table with
// chairs round it hosts a card game, a lab bench a spell of tinkering, a bunk a
// rest. A settler claims a seat, walks to it, sits, and performs for a seeded
// stretch; a card game waits until enough seats fill, then every seat starts
// and ends on the same tick.
//
// The claim (`ai.activity`) lives only on the NPC. A site's occupancy is the
// set of live NPCs claiming it, so a death frees the seat by removing the body
// and an interrupt frees it by clearing the one field. Game state that the
// seats share (when it ends) is copied onto each claim when the game starts,
// so a mid-game snapshot carries it whole.

import type { ActivityClaim, ActivityKind, Entity } from '../entity'
import { isSolidTile } from '../levelgen/level'
import { vlen } from '../simMath'
import { sameStorey } from '../stairs'
import { SIM_RATE, type EntityId, type Vec2 } from '../types'
import type { World } from '../world'

export interface ActivityDef {
  /** Prop archetype that offers it. */
  site: string
  /** 'chairs': one seat per chair round the site. 'self': the site is the seat. */
  seats: 'chairs' | 'self'
  /** Seats that must be filled before play starts. */
  min: number
  /** Inclusive tick range one session lasts, rolled once per session. */
  play: readonly [number, number]
  /** How far a settler walks for it, tiles. */
  range: number
}

export const ACTIVITIES: Record<ActivityKind, ActivityDef> = {
  cards: { site: 'table', seats: 'chairs', min: 2, play: [30 * SIM_RATE, 60 * SIM_RATE], range: 24 },
  tinker: { site: 'bench', seats: 'self', min: 1, play: [15 * SIM_RATE, 30 * SIM_RATE], range: 10 },
  rest: { site: 'bunk', seats: 'self', min: 1, play: [20 * SIM_RATE, 40 * SIM_RATE], range: 8 },
}

const KINDS = Object.keys(ACTIVITIES) as ActivityKind[]
const KIND_BY_SITE = new Map<string, ActivityKind>(KINDS.map((k) => [ACTIVITIES[k].site, k]))

export const isActivityCode = (code: string | undefined): code is ActivityKind =>
  code !== undefined && code in ACTIVITIES

/** Who takes part: the settlers (civ faction). */
export const takesPart = (e: Entity): boolean => e.ai?.faction === 'civ'

/** A chair this close to a table is one of its seats. */
const SEAT_REACH = 1.6
/** Close enough to the seat point to sit. */
export const SEAT_ARRIVE = 0.3
/** A claim still walking after this long is given up (the seat is unreachable). */
export const GOING_MAX = 20 * SIM_RATE
/** A seated player left waiting this long for partners gives up. */
export const WAIT_MAX = 20 * SIM_RATE
/** Rest between sessions, rolled per NPC when a claim ends. */
export const LEISURE_COOLDOWN: readonly [number, number] = [20 * SIM_RATE, 45 * SIM_RATE]
/** A fresh NPC's first look for something to do is staggered by id, up to this. */
const FIRST_LOOK_SPREAD = 10

/** Live NPCs claiming seats at `siteId`, in entity order. */
export const claimantsOf = (w: World, siteId: EntityId): Entity[] =>
  w.entities.filter((e) => !e.dead && e.ai?.activity?.site === siteId)

/** The seats a site offers, in entity order. */
export const seatsOf = (w: World, site: Entity): Entity[] => {
  const def = ACTIVITIES[KIND_BY_SITE.get(site.archetype)!]
  if (def.seats === 'self') return [site]
  return w.entities.filter(
    (c) => !c.dead && c.archetype === 'chair' && vlen(c.pos.x - site.pos.x, c.pos.y - site.pos.y) <= SEAT_REACH,
  )
}

const ORTHO: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
]

/** Where the body goes for a claim: on the chair, in the bunk, or at the
 * bench's open side. Undefined when the seat or site is gone. */
export const seatPoint = (w: World, claim: ActivityClaim): Vec2 | undefined => {
  const seat = w.byId.get(claim.seat)
  if (!seat || seat.dead || !w.byId.get(claim.site) || w.byId.get(claim.site)!.dead) return undefined
  if (claim.kind !== 'tinker') return { x: seat.pos.x, y: seat.pos.y }
  const tx = Math.floor(seat.pos.x)
  const ty = Math.floor(seat.pos.y)
  for (const [dx, dy] of ORTHO) {
    if (!isSolidTile(w.level, tx + dx, ty + dy)) return { x: seat.pos.x + dx * 0.65, y: seat.pos.y + dy * 0.65 }
  }
  return { x: seat.pos.x, y: seat.pos.y }
}

/** Is a site mid-session (no new players until it ends)? */
const inSession = (claimants: readonly Entity[]): boolean => claimants.some((c) => c.ai!.activity!.phase === 'playing')

export interface SitePick {
  kind: ActivityKind
  site: EntityId
  seat: EntityId
  at: Vec2
}

/** What `e` is free to start: nothing until its cooldown is over (a fresh
 * NPC's first look is staggered by id so a floor does not stampede the tables
 * at once). */
export const activityKinds = (w: World, e: Entity): readonly ActivityKind[] => {
  if (!takesPart(e) || w.tick < (e.ai!.leisureAt ?? (e.id % FIRST_LOOK_SPREAD) * SIM_RATE)) return []
  return KINDS
}

/** Distance discount by kind: a card game needs company, so a table is worth a
 * longer walk, and one where someone already waits is worth a longer one still. */
const PULL: Record<ActivityKind, number> = { cards: 0.5, tinker: 1, rest: 1.5 }
const COMPANY_PULL = 0.4

/** The nearest site within range with a free seat and no session running.
 * Card tables are preferred to solo props at equal footing by a distance
 * discount, since a game needs company and is the thing worth walking to. */
export const findSite = (w: World, e: Entity, kinds: readonly ActivityKind[]): SitePick | undefined => {
  let best: SitePick | undefined
  let bestD = Infinity
  for (const s of w.entities) {
    if (s.dead) continue
    const kind = KIND_BY_SITE.get(s.archetype)
    if (!kind || !kinds.includes(kind)) continue
    const d = vlen(s.pos.x - e.pos.x, s.pos.y - e.pos.y)
    if (d > ACTIVITIES[kind].range || !sameStorey(s.pos.x, e.pos.x)) continue
    if (d * PULL[kind] * (kind === 'cards' ? COMPANY_PULL : 1) >= bestD) continue
    const seats = seatsOf(w, s)
    if (seats.length < ACTIVITIES[kind].min) continue
    const claimants = claimantsOf(w, s.id)
    if (inSession(claimants)) continue
    const weighted = d * PULL[kind] * (claimants.length > 0 ? COMPANY_PULL : 1)
    if (weighted >= bestD) continue
    const taken = new Set(claimants.map((c) => c.ai!.activity!.seat))
    const seat = seats.find((c) => !taken.has(c.id))
    if (!seat) continue
    const at = seatPoint(w, { kind, site: s.id, seat: seat.id, phase: 'going', since: w.tick })
    if (!at) continue
    best = { kind, site: s.id, seat: seat.id, at }
    bestD = weighted
  }
  return best
}

/** Take a seat. */
export const claimSeat = (w: World, e: Entity, pick: { kind: ActivityKind; site: EntityId; seat: EntityId }): void => {
  e.ai!.activity = { kind: pick.kind, site: pick.site, seat: pick.seat, phase: 'going', since: w.tick }
}

/** Give the seat up and start the cooldown before the next one. */
export const releaseSeat = (w: World, e: Entity): void => {
  const ai = e.ai!
  if (!ai.activity) return
  ai.activity = undefined
  ai.leisureAt = w.tick + w.rng.int(LEISURE_COOLDOWN[0], LEISURE_COOLDOWN[1])
  if (ai.mode === 'perform') ai.mode = 'idle'
  ai.commit = undefined
  ai.thinkAt = w.tick
}

/** What a body is visibly doing at a prop: seated (waiting) or playing.
 * Walking to the seat shows nothing. Reads the host's claim, or a client's
 * wire mirror of it. */
export const shownActivity = (e: Entity): { kind: ActivityKind; playing: boolean } | undefined => {
  const claim = e.ai?.activity
  if (!claim) return e.activityShown
  return claim.phase === 'going' ? undefined : { kind: claim.kind, playing: claim.phase === 'playing' }
}

/** Sitting down at the seat: face what the seat is for. */
export const sitDown = (w: World, e: Entity): void => {
  const claim = e.ai!.activity!
  const site = w.byId.get(claim.site)
  if (site && claim.kind !== 'rest') e.facing = Math.atan2(site.pos.y - e.pos.y, site.pos.x - e.pos.x)
  if (claim.phase === 'going') {
    claim.phase = 'seated'
    claim.since = w.tick
  }
}

const endSession = (w: World, siteId: EntityId, kind: ActivityKind, seats: Entity[], why: 'done' | 'broken' | 'timeout'): void => {
  w.events.push({ type: 'activity', entityId: siteId, kind, phase: 'end', seats: seats.map((s) => s.id), why })
  for (const s of seats) releaseSeat(w, s)
}

/**
 * The per-tick pass over every claimed site, in site-id order: start a
 * session once its seats are filled, end it together when its time is up or
 * it lost its quorum, and drop claims that never got anywhere.
 */
export const activitySystem = (w: World): void => {
  const bySite = new Map<EntityId, Entity[]>()
  for (const e of w.entities) {
    const claim = e.ai?.activity
    if (!claim || e.dead) continue
    const list = bySite.get(claim.site)
    if (list) list.push(e)
    else bySite.set(claim.site, [e])
  }
  for (const siteId of [...bySite.keys()].sort((a, b) => a - b)) {
    const claimants = bySite.get(siteId)!
    const kind = claimants[0].ai!.activity!.kind
    const def = ACTIVITIES[kind]
    const site = w.byId.get(siteId)
    if (!site || site.dead) {
      endSession(w, siteId, kind, claimants, 'broken')
      continue
    }
    if (inSession(claimants)) {
      const until = claimants.find((c) => c.ai!.activity!.phase === 'playing')!.ai!.activity!.until!
      if (w.tick >= until) endSession(w, siteId, kind, claimants, 'done')
      else if (claimants.length < def.min) endSession(w, siteId, kind, claimants, 'broken')
      continue
    }
    for (const c of claimants) {
      const claim = c.ai!.activity!
      if (claim.phase === 'going' && w.tick - claim.since > GOING_MAX) releaseSeat(w, c)
    }
    const left = claimants.filter((c) => c.ai!.activity)
    const seated = left.filter((c) => c.ai!.activity!.phase === 'seated')
    if (seated.length >= def.min && seated.length === left.length) {
      const until = w.tick + w.rng.int(def.play[0], def.play[1])
      for (const c of seated) {
        const claim = c.ai!.activity!
        claim.phase = 'playing'
        claim.since = w.tick
        claim.until = until
      }
      w.events.push({ type: 'activity', entityId: siteId, kind, phase: 'start', seats: seated.map((s) => s.id) })
      continue
    }
    const stale = seated.filter((c) => w.tick - c.ai!.activity!.since > WAIT_MAX)
    if (stale.length > 0) endSession(w, siteId, kind, stale, 'timeout')
  }
}
