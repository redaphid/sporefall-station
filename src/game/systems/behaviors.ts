// Pluggable NPC behaviors — utility AI over a data-driven registry.
//
// ARCHITECTURE. An NPC's brain is a COMPONENT, not code wired to its archetype:
// `ai.behavior` is a registry id (plus optional `ai.params`, e.g. patrol
// waypoints), and every mutable decision datum (target, waypoint, search sweep,
// stash, last consideration scores) lives ON the entity — so a snapshot taken
// mid-decision serializes and replays byte-identically.
//
// A BEHAVIOR is just an ordered list of CONSIDERATION ids. Each consideration is
// one pure-ish scoring function (it may only touch the world RNG and its own
// entity's ai state) that proposes candidate goals with a (tier, score) pair:
//
//   tier 3 PANIC    — overriding self-preservation (keep fleeing, raise the alarm)
//   tier 2 THREAT   — a perceived enemy: fight or flee it
//   tier 1 MEMORY   — a remembered-but-unseen target: pursue / keep fleeing / sweep
//   tier 0 AMBIENT  — everything is calm: patrol, scavenge, investigate, wander
//
// `decide` takes the highest tier's best scorer (strictly-greater, in
// consideration order, candidates in returned order — fully deterministic, no
// rand in arbitration itself). The tier ladder is what makes behaviors genuinely
// mix-and-match: dropping `patrol` into a list can never override combat, because
// combat candidates live on a higher tier. Composing the default list reproduces
// the pre-registry arbitration exactly (see `basic`).
//
// Adding a behavior = registering one entry here (or one new consideration
// function) and putting its id on entities. Unknown ids fall back to `basic`, so
// a stale snapshot or a typo can never crash the sim.
//
// LEGIBILITY. Every think writes `ai.lastScores` (per-consideration top score),
// `ai.goal`/`ai.goalSince` record what was chosen and when, and notable
// transitions emit an `aiGoal` world event — so "why did this NPC do that?" is
// answerable from the entity's own JSON (debug verbs `ai`, `behaviors`).

import { NPCS } from '../data/npcs'
import type { Entity } from '../entity'
import type { World } from '../world'
import {
  BATTLE,
  ENGAGE_RANGE,
  FLEE,
  INVESTIGATE,
  INVESTIGATE_SCORE,
  LEASH,
  PURSUE,
  WANDER,
  WANDER_SCORE,
  battleScore,
  canSeeEntity,
  fleeScore,
  hateToward,
  nearestNoise,
  perceives,
  type Goal,
} from './goals'
import { dispositionToward } from './relationships'

// ── Goal codes owned by the registry behaviors ─────────────────────────────
export const PATROL = 'patrol'
export const SEARCH = 'search'
export const ALERT = 'alert'
export const SCAVENGE = 'scavenge'

// ── Decision tiers (see header) ────────────────────────────────────────────
export const TIER_AMBIENT = 0
export const TIER_MEMORY = 1
export const TIER_THREAT = 2
export const TIER_PANIC = 3

/** One candidate goal a consideration puts forward. */
export interface Candidate extends Goal {
  score: number
  tier: number
}

export type Consideration = (w: World, e: Entity) => Candidate[]

const dist2d = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(ax - bx, ay - by)

// ── Threat: fight-or-flight against every perceived enemy ──────────────────
// The candidates must STRICTLY beat the wander baseline to register, exactly as
// the pre-registry arbitration compared them against `WANDER_SCORE`.
const threat: Consideration = (w, e) => {
  const ai = e.ai!
  const hp = e.health?.hp ?? 1
  const max = e.health?.max ?? 1
  const out: Candidate[] = []
  for (const p of w.entities) {
    if (!p.playerCtl || p.dead || p.playerCtl.downed) continue
    const hostile = w.hostile || dispositionToward(e, p.id) === 'Hostile' || (ai.faction === 'cop' && w.alarm >= 2)
    if (!hostile) continue
    const dist = Math.max(1, dist2d(p.pos.x, p.pos.y, e.pos.x, e.pos.y))
    if (!perceives(w, e, p)) continue // must actually perceive it (range + LOS, cloak-aware)
    const hate = hateToward(w, e, p.id)
    const aggress = battleScore(hate, hp, dist)
    if (aggress > WANDER_SCORE)
      out.push({ code: dist <= ENGAGE_RANGE ? BATTLE : PURSUE, score: aggress, tier: TIER_THREAT, target: p.id })
    const flee = fleeScore(hate, hp, max, dist)
    if (flee > WANDER_SCORE) out.push({ code: FLEE, score: flee, tier: TIER_THREAT, target: p.id })
  }
  return out
}

// ── Panic / fear: a scared NPC keeps running until it is well clear ────────
// `panic` is the pre-registry rule: only archetypes marked `fleesOnDamage`
// (civilian/scientist) lock into flight. `fear` is the ungated variant for
// behaviors that should cower regardless of archetype (skittish, scavenger).
const fearCandidates = (w: World, e: Entity, archetypeGated: boolean): Candidate[] => {
  const ai = e.ai!
  if (archetypeGated && !NPCS[e.archetype]?.fleesOnDamage) return []
  if (ai.mode !== 'flee' || ai.targetId === undefined) return []
  const threatE = w.byId.get(ai.targetId)
  if (!threatE || threatE.dead) return []
  if (dist2d(threatE.pos.x, threatE.pos.y, e.pos.x, e.pos.y) > ai.sightRange * 2) return []
  return [{ code: FLEE, score: 1, tier: TIER_PANIC, target: ai.targetId }]
}
const panic: Consideration = (w, e) => fearCandidates(w, e, true)
const fear: Consideration = (w, e) => fearCandidates(w, e, false)

// ── Memory: a remembered-but-unseen target is worth acting on ──────────────
const MEMORY_SCORE = WANDER_SCORE + 0.5

const pursueMemory: Consideration = (w, e) => {
  const ai = e.ai!
  if (ai.targetId === undefined || !ai.lastKnownTargetPos) return []
  const t = w.byId.get(ai.targetId)
  if (!t || t.dead || dist2d(t.pos.x, t.pos.y, e.pos.x, e.pos.y) > ai.sightRange * LEASH) return []
  return [{ code: PURSUE, score: MEMORY_SCORE, tier: TIER_MEMORY, target: ai.targetId }]
}

// A frightened NPC (e.g. a civilian who saw a crime) keeps fleeing its scarer
// until it's well clear, even with no hostile disposition to score.
const fleeMemory: Consideration = (w, e) => {
  const ai = e.ai!
  if (ai.mode !== 'flee' || ai.targetId === undefined) return []
  const t = w.byId.get(ai.targetId)
  if (!t || t.dead || dist2d(t.pos.x, t.pos.y, e.pos.x, e.pos.y) > ai.sightRange * 2) return []
  return [{ code: FLEE, score: MEMORY_SCORE, tier: TIER_MEMORY, target: ai.targetId }]
}

// ── Investigate: a heard disturbance with nothing scarier around ───────────
const investigate: Consideration = (w, e) => {
  const noise = nearestNoise(w, e)
  if (!noise) return []
  return [{ code: INVESTIGATE, score: INVESTIGATE_SCORE, tier: TIER_AMBIENT, at: noise }]
}

// ── Wander: the ambient baseline every behavior falls back to ──────────────
const wander: Consideration = () => [{ code: WANDER, score: WANDER_SCORE, tier: TIER_AMBIENT }]

// ── Patrol: walk a fixed waypoint loop (params.waypoints) ──────────────────
const PATROL_SCORE = 2
/** Close enough to a patrol waypoint to move on to the next leg. */
const PATROL_ARRIVE = 0.6

const patrol: Consideration = (_w, e) => {
  const ai = e.ai!
  const wps = ai.params?.waypoints
  if (!wps || wps.length === 0) return []
  let i = (ai.patrolIndex ?? 0) % wps.length
  // Arrived → advance to the next leg (mutable AI state, on the entity).
  if (dist2d(wps[i].x, wps[i].y, e.pos.x, e.pos.y) < PATROL_ARRIVE) {
    i = (i + 1) % wps.length
    ai.patrolIndex = i
  }
  return [{ code: PATROL, score: PATROL_SCORE, tier: TIER_AMBIENT, at: { x: wps[i].x, y: wps[i].y } }]
}

// ── Hunt: relentless pursuit + an area sweep when the trail goes cold ──────
const HUNT_PURSUE_SCORE = WANDER_SCORE + 0.6
const HUNT_SEARCH_SCORE = WANDER_SCORE + 0.4
/** Sweep points checked around the spot where the trail went cold. */
const HUNT_SWEEPS = 3
/** Radius (tiles) of the sweep around the cold-trail anchor. */
const HUNT_SWEEP_RADIUS = 3
/** Ticks before an unreachable sweep point is abandoned (~2s at 30tps). */
const HUNT_SWEEP_TIMEOUT = 60
/** Close enough to a sweep point to call it checked. */
const HUNT_ARRIVE = 0.7

const hunt: Consideration = (w, e) => {
  const ai = e.ai!
  if (ai.targetId === undefined) {
    ai.search = undefined
    return []
  }
  const quarry = w.byId.get(ai.targetId)
  if (!quarry || quarry.dead) {
    // The quarry despawned mid-hunt: nothing to search for.
    ai.search = undefined
    ai.targetId = undefined
    ai.lastKnownTargetPos = undefined
    return []
  }
  // A remembered position is pursued relentlessly — no leash (contrast pursueMemory).
  if (ai.lastKnownTargetPos) {
    ai.search = undefined
    return [{ code: PURSUE, score: HUNT_PURSUE_SCORE, tier: TIER_MEMORY, target: ai.targetId }]
  }
  // The trail went cold at our feet (steer cleared lastKnownTargetPos on
  // arrival) → open a sweep around this spot.
  if (ai.mode === 'aggro' && !ai.search) {
    ai.search = { cx: e.pos.x, cy: e.pos.y, x: e.pos.x, y: e.pos.y, left: HUNT_SWEEPS, until: w.tick }
  }
  const s = ai.search
  if (!s) return []
  // Point checked (or unreachable past its timeout) → roll the next one off the
  // world RNG; sweeps exhausted → give up the hunt entirely.
  if (dist2d(s.x, s.y, e.pos.x, e.pos.y) < HUNT_ARRIVE || w.tick >= s.until) {
    s.left--
    if (s.left <= 0) {
      ai.search = undefined
      ai.targetId = undefined
      return []
    }
    s.x = s.cx + w.rng.int(-HUNT_SWEEP_RADIUS, HUNT_SWEEP_RADIUS)
    s.y = s.cy + w.rng.int(-HUNT_SWEEP_RADIUS, HUNT_SWEEP_RADIUS)
    s.until = w.tick + HUNT_SWEEP_TIMEOUT
  }
  return [{ code: SEARCH, score: HUNT_SEARCH_SCORE, tier: TIER_MEMORY, at: { x: s.x, y: s.y } }]
}

// ── Alert: a scared NPC runs to the nearest guard and raises the alarm ─────
const ALERT_SCORE = 2
/** How far away a guard can be and still be worth running to. */
export const ALERT_RANGE = 14

const alertGuards: Consideration = (w, e) => {
  const ai = e.ai!
  // Who scared us: mid-alert the threat is `fearId` (targetId is the guard);
  // otherwise it's the entity being fled from.
  const threatId = ai.goal === ALERT ? ai.fearId : ai.mode === 'flee' ? ai.targetId : undefined
  if (threatId === undefined || ai.alerted === threatId) return []
  const threatE = w.byId.get(threatId)
  if (!threatE || threatE.dead) return []
  let guard: Entity | undefined
  let bestD = Infinity
  for (const g of w.entities) {
    if (g === e || g.dead || !g.ai || g.ai.faction !== 'cop') continue
    const d = dist2d(g.pos.x, g.pos.y, e.pos.x, e.pos.y)
    if (d > ALERT_RANGE || d >= bestD) continue
    bestD = d
    guard = g
  }
  if (!guard) return []
  return [{ code: ALERT, score: ALERT_SCORE, tier: TIER_PANIC, target: guard.id, subject: threatId }]
}

// ── Scavenge: drawn to loose items it can see ──────────────────────────────
const SCAVENGE_SCORE = 2

const scavenge: Consideration = (w, e) => {
  const ai = e.ai!
  let best: Entity | undefined
  let bestD = Infinity
  for (const p of w.entities) {
    if (p.dead || !p.pickup) continue
    // Never loot the mission objective or a weapon-mod gem — those belong to the
    // players' run, and a scavenged briefcase would soft-lock the floor.
    if (p.id === w.mission.targetEntityId || p.archetype.startsWith('mod.')) continue
    const d = dist2d(p.pos.x, p.pos.y, e.pos.x, e.pos.y)
    if (d > ai.sightRange || d >= bestD) continue
    if (!canSeeEntity(w, e, p)) continue
    bestD = d
    best = p
  }
  if (!best) return []
  return [{ code: SCAVENGE, score: SCAVENGE_SCORE, tier: TIER_AMBIENT, target: best.id }]
}

// ── The registries ─────────────────────────────────────────────────────────

export const CONSIDERATIONS: Record<string, Consideration> = {
  panic,
  fear,
  threat,
  hunt,
  alertGuards,
  pursueMemory,
  fleeMemory,
  investigate,
  patrol,
  scavenge,
  wander,
}

export interface BehaviorDef {
  /** One-line description for the `behaviors` debug verb. */
  about: string
  /** Ordered consideration ids — the order is the deterministic tie-break. */
  considerations: readonly string[]
}

export const DEFAULT_BEHAVIOR = 'basic'

export const BEHAVIORS: Record<string, BehaviorDef> = {
  basic: {
    about: 'fight, flee, investigate, wander — the default townsfolk brain',
    considerations: ['panic', 'threat', 'pursueMemory', 'fleeMemory', 'investigate', 'wander'],
  },
  patrol: {
    about: 'walks a fixed waypoint beat; still fights and investigates',
    considerations: ['panic', 'threat', 'pursueMemory', 'fleeMemory', 'investigate', 'patrol', 'wander'],
  },
  hunter: {
    about: 'presses a chase to last-known position, then sweeps the area before giving up',
    considerations: ['threat', 'hunt', 'fleeMemory', 'investigate', 'wander'],
  },
  skittish: {
    about: 'flees trouble and runs to the nearest guard to raise the alarm',
    considerations: ['alertGuards', 'fear', 'threat', 'pursueMemory', 'fleeMemory', 'investigate', 'wander'],
  },
  scavenger: {
    about: 'drawn to loose items it can see; grabs them into its stash',
    considerations: ['fear', 'threat', 'fleeMemory', 'scavenge', 'wander'],
  },
}

/** Resolve an entity's behavior, falling back to `basic` for a missing or
 * unknown id — a stale snapshot or typo degrades gracefully, never crashes. */
export const behaviorFor = (e: Entity): BehaviorDef =>
  BEHAVIORS[e.ai?.behavior ?? DEFAULT_BEHAVIOR] ?? BEHAVIORS[DEFAULT_BEHAVIOR]

export interface Decision {
  goal: Goal
  /** Per-consideration top score of this think — the "why" trail. */
  scores: Record<string, number>
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000

/** Run one think: evaluate the entity's behavior and pick the winning goal.
 * Highest tier wins; within a tier, strictly-greater score in consideration /
 * candidate order — byte-for-byte deterministic. */
export const decide = (w: World, e: Entity): Decision => {
  const def = behaviorFor(e)
  let best: Candidate = { code: WANDER, score: WANDER_SCORE, tier: TIER_AMBIENT }
  const scores: Record<string, number> = {}
  for (const id of def.considerations) {
    const consider = CONSIDERATIONS[id]
    if (!consider) continue
    for (const c of consider(w, e)) {
      const top = scores[id]
      if (top === undefined || c.score > top) scores[id] = round3(c.score)
      if (c.tier > best.tier || (c.tier === best.tier && c.score > best.score)) best = c
    }
  }
  const goal: Goal = { code: best.code }
  if (best.target !== undefined) goal.target = best.target
  if (best.at) goal.at = best.at
  if (best.subject !== undefined) goal.subject = best.subject
  return { goal, scores }
}

/** Single-shot arbitration for the entity's behavior (`basic` when unset) —
 * kept as the stable one-call surface for tests and tools. */
export const arbitrateGoal = (w: World, e: Entity): Goal => decide(w, e).goal
