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
import { type Building, rectCenter, rectContains } from '../levelgen/level'
import { anyPowerCut, type FearPulse, type World } from '../world'
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
import { infectionActive } from './infection'
import { determineRel, dispositionToward, initialFactionHate } from './relationships'
import { strongestStimulus } from './stimulus'

// ── Goal codes owned by the registry behaviors ─────────────────────────────
export const PATROL = 'patrol'
export const SEARCH = 'search'
export const ALERT = 'alert'
export const SCAVENGE = 'scavenge'
// Squad choreography (see the `squad` behavior below).
export const FORMUP = 'formup'
export const STACK = 'stack'
export const FLANK = 'flank'

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

/** #63 — is `target` an enemy `e` should fight/flee? The one hostility predicate
 * the `threat` scan uses. Players keep the exact pre-#63 rule. NPC-vs-NPC (ON by
 * default; `w.aiFlags.npcVsNpc === false` restores the players-only scan) reads
 * a stored opinion first, then the FACTION MATRIX (`initialFactionHate`), so
 * sworn enemies (cop↔gang) are mutually Hostile, same-faction stays Friendly,
 * and unrelated factions ignore each other — the crew, the law, and the gangs
 * tear into each OTHER, not just the players. Pure lookups, ascending-id caller. */
const isHostileTarget = (w: World, e: Entity, target: Entity): boolean => {
  const ai = e.ai!
  // #64 — the Infected and the uninfected are mutual enemies regardless of
  // faction: a body is either host or prey. Overrides faction/player rules.
  if (infectionActive(w) && (e.infected || target.infected)) {
    return e.infected ? !target.infected : !!target.infected
  }
  if (target.playerCtl) {
    if (target.dead || target.playerCtl.downed) return false
    // Derelict Units (robots) sleep through a peaceful station, but a power cut
    // wakes them into open hostility — the standing cost of the power-cut path.
    return (
      w.hostile ||
      dispositionToward(e, target.id) === 'Hostile' ||
      (ai.faction === 'cop' && w.alarm >= 2) ||
      (!!ai.wakeOn?.includes('power-cut') && anyPowerCut(w))
    )
  }
  if (w.aiFlags?.npcVsNpc === false || !target.ai || target === e) return false
  // A stored grudge (a witnessed crime, retaliation) wins; else the opening
  // faction stance decides — this is what wakes the dormant sworn-enemy matrix.
  const stored = ai.rel?.[target.id]
  if (stored) return stored.code === 'Hostile'
  return determineRel(initialFactionHate(ai.faction, target.ai.faction)) === 'Hostile'
}

// ── Threat: fight-or-flight against every perceived enemy ──────────────────
// The candidates must STRICTLY beat the wander baseline to register, exactly as
// the pre-registry arbitration compared them against `WANDER_SCORE`.
const threat: Consideration = (w, e) => {
  const hp = e.health?.hp ?? 1
  const max = e.health?.max ?? 1
  const out: Candidate[] = []
  // #63: score any Hostile entity, not only players. The player-only scan is
  // the fast path when NPC-vs-NPC is forced off. Perf: naive O(N²) over the
  // cast — fine at current NPC counts; bucket the wide scan if deeper floors
  // grow the population (noted on the issue).
  const pool = w.aiFlags?.npcVsNpc === false ? w.entities.filter((x) => x.playerCtl) : w.entities
  for (const p of pool) {
    if (p === e || p.dead || !p.health) continue
    if (!isHostileTarget(w, e, p)) continue
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

// ── #65 Contagious fear: a scream travels. A timid crew member within range of
// a fear pulse (a fleeing/dying body's terror) stampedes AWAY from it — even
// with no first-hand sight of the threat — so panic rolls down a corridor as a
// wave. Scored just BELOW first-hand panic, so a real, seen threat still wins;
// gated to `fleesOnDamage` crew, so hardened factions don't stampede. ──────────
const FEAR_RADIUS = 5
const CONTAGIOUS_FEAR_SCORE = 0.8 // < first-hand panic (1)

const contagiousFear: Consideration = (w, e) => {
  if (!NPCS[e.archetype]?.fleesOnDamage) return []
  let best: FearPulse | undefined
  let bestD = FEAR_RADIUS
  for (const f of w.fear) {
    if (f.sourceId === e.id) continue // never catch your own scream
    if (f.born === w.tick) continue // a pulse is only caught on a LATER tick (rolling wave, not a flash)
    const d = dist2d(f.x, f.y, e.pos.x, e.pos.y)
    if (d > bestD) continue
    bestD = d
    best = f
  }
  if (!best) return []
  return [{ code: FLEE, score: CONTAGIOUS_FEAR_SCORE, tier: TIER_PANIC, at: { x: best.x, y: best.y } }]
}

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

// ── #66 Draw field: a hive member with no direct target drifts toward the
// STRONGEST nearby stimulus (loudest noise / brightest bloom / fire) — so a
// swarm pools on a shared focus and can be baited off the players. A flocking
// bias at MEMORY tier: it beats wander/investigate but any perceived target
// (threat/infest, THREAT tier) still overrides it. ────────────────────────────
export const DRAWN = 'drawn'
const DRAW_RANGE = 16
const DRAW_SCORE = WANDER_SCORE + 0.6

const drawnToStimulus: Consideration = (w, e) => {
  const s = strongestStimulus(w, e.pos.x, e.pos.y, DRAW_RANGE)
  if (!s) return []
  return [{ code: DRAWN, score: DRAW_SCORE, tier: TIER_MEMORY, at: { x: s.x, y: s.y } }]
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
/** Corner beat: reaching a waypoint, the patroller plants and sweeps its
 * facing for this long before walking the next leg — the deliberate "check the
 * corner" pause (steer's scan gate reads `ai.scanUntil`). */
const PATROL_PAUSE = 24

const patrol: Consideration = (w, e) => {
  const ai = e.ai!
  const wps = ai.params?.waypoints
  if (!wps || wps.length === 0) return []
  let i = (ai.patrolIndex ?? 0) % wps.length
  // Arrived → pause to scan the corner, then advance to the next leg (mutable
  // AI state, on the entity).
  if (dist2d(wps[i].x, wps[i].y, e.pos.x, e.pos.y) < PATROL_ARRIVE) {
    i = (i + 1) % wps.length
    ai.patrolIndex = i
    ai.scanUntil = w.tick + PATROL_PAUSE
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

// ── #77 Territory: NPCs derive goals from the station module they belong to ──
// A zoned NPC (populate stamps `ai.zone`) doesn't wander the whole map: it holds
// its own building (`workMyRoom`), and — if it belongs to the objective wing —
// masses on the objective room as a garrison (`garrison`) and turns on any
// intruder that breaches its turf (`defendMyWing`). Unzoned NPCs (street life,
// test/scenario spawns) fall through untouched. All pure lookups over the level
// geometry + ascending-id scans; no `Date`/`Math.random`.
export const WORK = 'work'
export const GARRISON = 'garrison'

/** A resident holds its room over aimless wander (beats WANDER, loses to
 * investigate/patrol so a real disturbance or beat still wins). */
const WORK_SCORE = WANDER_SCORE + 0.3
/** The objective wing's garrison pools on the core — above patrol, so the guards
 * assigned a beat still converge on the room the players must breach. */
const GARRISON_SCORE = 2.5
/** Defending the wing is a THREAT-tier escalation, a hair above the wander floor
 * so it always registers; it rides the same aggro path as `threat`. */
const DEFEND_SCORE = WANDER_SCORE + 2

const buildingOf = (w: World, e: Entity): Building | undefined => {
  const z = e.ai?.zone
  if (!z) return undefined
  return w.level.buildings[z.building]
}

// A resident with no threat holds station in its OWN building — steers back to
// its home room when it drifts out, then settles at its post. Legible "this NPC
// belongs here" behaviour instead of map-wide wander.
const workMyRoom: Consideration = (w, e) => {
  if (!buildingOf(w, e)) return []
  const home = e.ai!.home
  return [{ code: WORK, score: WORK_SCORE, tier: TIER_AMBIENT, at: { x: home.x, y: home.y } }]
}

// The objective building's residents form a GARRISON: absent an intruder they
// converge on and hold the objective room — guards massing on the wing the
// players must breach, instead of scattering to their own posts.
const garrison: Consideration = (w, e) => {
  const z = e.ai?.zone
  if (!z || w.mission.targetBuilding !== z.building) return []
  const b = w.level.buildings[z.building]
  const room = b?.objectiveRoom ?? b?.rect
  if (!room) return []
  return [{ code: GARRISON, score: GARRISON_SCORE, tier: TIER_AMBIENT, at: rectCenter(room) }]
}

// A fighting resident escalates on any intruder INSIDE its wing — a localized
// garrison response, not the whole-floor alarm flash. The timid (fleesOnDamage
// workers) don't charge; they rely on flee/panic.
const defendMyWing: Consideration = (w, e) => {
  const b = buildingOf(w, e)
  if (!b || NPCS[e.archetype]?.fleesOnDamage) return []
  const out: Candidate[] = []
  for (const p of w.entities) {
    if (p === e || p.dead || !p.health) continue
    const intruder = p.playerCtl ? !p.playerCtl.downed : isHostileTarget(w, e, p)
    if (!intruder) continue
    if (!rectContains(b.rect, Math.floor(p.pos.x), Math.floor(p.pos.y))) continue
    if (!perceives(w, e, p)) continue
    const dist = Math.max(1, dist2d(p.pos.x, p.pos.y, e.pos.x, e.pos.y))
    out.push({ code: dist <= ENGAGE_RANGE ? BATTLE : PURSUE, score: DEFEND_SCORE, tier: TIER_THREAT, target: p.id })
  }
  return out
}

// ── #64 Infest: the mindless Infected host — shamble at the nearest clean
// body, never flee, never reason. Only fires on an `infected` entity. ─────────
const INFEST_SCORE = 5

const infest: Consideration = (w, e) => {
  if (!e.infected) return []
  let best: Entity | undefined
  let bestD = Infinity
  for (const p of w.entities) {
    if (p.dead || !p.health || p.infected) continue
    if (!p.playerCtl && !p.ai) continue // a living body to hunt
    if (!perceives(w, e, p)) continue
    const d = dist2d(p.pos.x, p.pos.y, e.pos.x, e.pos.y)
    if (d < bestD) {
      bestD = d
      best = p
    }
  }
  if (!best) return []
  return [{ code: bestD <= ENGAGE_RANGE ? BATTLE : PURSUE, score: INFEST_SCORE, tier: TIER_THREAT, target: best.id }]
}

// ── #67 Predator ecology: a scavenger hunts the WEAKEST thing it sees and shies
// from a healthy pack. Prey = any living body of a DIFFERENT faction (players
// have none → always prey); its own kind (same faction) is the pack, never
// hunted, so a brood stays coherent while culling the wounded of every side. ───
const STALK_SCORE = 4
const PACK_K = 3 // this many healthy enemies within reach → disengage
const PACK_RADIUS = 6
const HEALTHY_FRAC = 0.6 // "healthy" = hp at/above this fraction of max

const isPrey = (e: Entity, p: Entity): boolean =>
  p !== e && !p.dead && !!p.health && (!!p.playerCtl || !!p.ai) && p.ai?.faction !== e.ai!.faction

// Prefer the lowest-HP perceived body — the wounded get finished.
const stalkWeakest: Consideration = (w, e) => {
  let best: Entity | undefined
  let bestHp = Infinity
  for (const p of w.entities) {
    if (!isPrey(e, p) || !perceives(w, e, p)) continue
    if (p.health!.hp < bestHp) {
      bestHp = p.health!.hp
      best = p
    }
  }
  if (!best) return []
  const dist = Math.max(1, dist2d(best.pos.x, best.pos.y, e.pos.x, e.pos.y))
  return [{ code: dist <= ENGAGE_RANGE ? BATTLE : PURSUE, score: STALK_SCORE, tier: TIER_THREAT, target: best.id }]
}

// Outnumbered by HEALTHY enemies → break off and reposition (PANIC tier, so it
// overrides the stalk: a predator won't wade into a losing fight).
const packAvoid: Consideration = (w, e) => {
  let healthy = 0
  let nearest: Entity | undefined
  let nd = Infinity
  for (const p of w.entities) {
    if (!isPrey(e, p)) continue
    const d = dist2d(p.pos.x, p.pos.y, e.pos.x, e.pos.y)
    if (d > PACK_RADIUS) continue
    if (p.health!.hp >= p.health!.max * HEALTHY_FRAC) {
      healthy++
      if (d < nd) {
        nd = d
        nearest = p
      }
    }
  }
  if (healthy >= PACK_K && nearest) return [{ code: FLEE, score: 1, tier: TIER_PANIC, target: nearest.id }]
  return []
}

// ── #69 Mireclaw Alpha: a PHASED apex predator (composes spore/hive/dormancy).
// Movement/targeting is gated on its own HP; the world-mutating side (summoning
// brood, regenerating in the cloud, the enrage speed burst) lives in
// systems/mireclaw.ts. Phase 1 (healthy) just pressures via `threat`/`hunt`. ───
/** Below this HP fraction the boss retreats to the spore cloud to regenerate. */
export const MIRECLAW_RETREAT_FRAC = 0.5
/** Below this HP fraction it ENRAGES — drops all self-preservation, goes faster. */
export const MIRECLAW_ENRAGE_FRAC = 0.2
export const RETREAT = 'retreat'

const nearestPlayer = (w: World, e: Entity): Entity | undefined => {
  let best: Entity | undefined
  let bestD = Infinity
  for (const p of w.entities) {
    if (!p.playerCtl || p.dead || p.playerCtl.downed) continue
    const d = dist2d(p.pos.x, p.pos.y, e.pos.x, e.pos.y)
    if (d < bestD) {
      bestD = d
      best = p
    }
  }
  return best
}

const nearestSpore = (w: World, e: Entity): Entity | undefined => {
  let best: Entity | undefined
  let bestD = Infinity
  for (const s of w.entities) {
    if (!s.spore || s.dead) continue
    const d = dist2d(s.pos.x, s.pos.y, e.pos.x, e.pos.y)
    if (d < bestD) {
      bestD = d
      best = s
    }
  }
  return best
}

// Phase 3: below the enrage line the boss abandons self-preservation and charges
// the nearest player at PANIC tier — outscoring any flee, so it NEVER breaks off.
const enrage: Consideration = (w, e) => {
  const hp = e.health?.hp ?? 1
  const max = e.health?.max ?? 1
  if (hp > max * MIRECLAW_ENRAGE_FRAC) return []
  const p = nearestPlayer(w, e)
  if (!p) return []
  const dist = Math.max(1, dist2d(p.pos.x, p.pos.y, e.pos.x, e.pos.y))
  return [{ code: dist <= ENGAGE_RANGE ? BATTLE : PURSUE, score: 20, tier: TIER_PANIC, target: p.id }]
}

// Phase 2: wounded (but not yet enraged) → retreat to the nearest spore cloud and
// hold there to regenerate (systems/mireclaw.ts heals it). PANIC tier suppresses
// the flee a wounded body would otherwise pick, and steers to the cloud instead.
const retreatToSpore: Consideration = (w, e) => {
  const hp = e.health?.hp ?? 1
  const max = e.health?.max ?? 1
  if (hp > max * MIRECLAW_RETREAT_FRAC || hp <= max * MIRECLAW_ENRAGE_FRAC) return []
  const spore = nearestSpore(w, e)
  if (!spore) return [] // no cloud to hide in → fall through to threat/hunt
  return [{ code: RETREAT, score: 6, tier: TIER_PANIC, at: { x: spore.pos.x, y: spore.pos.y } }]
}

// ── The registries ─────────────────────────────────────────────────────────

export const CONSIDERATIONS: Record<string, Consideration> = {
  panic,
  fear,
  contagiousFear,
  threat,
  defendMyWing,
  infest,
  packAvoid,
  stalkWeakest,
  enrage,
  retreatToSpore,
  hunt,
  alertGuards,
  pursueMemory,
  fleeMemory,
  investigate,
  drawnToStimulus,
  patrol,
  scavenge,
  garrison,
  workMyRoom,
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
    about: 'fight, flee, catch panic, investigate, hold its turf, wander — the default townsfolk brain',
    considerations: ['panic', 'contagiousFear', 'threat', 'defendMyWing', 'pursueMemory', 'fleeMemory', 'investigate', 'garrison', 'workMyRoom', 'wander'],
  },
  patrol: {
    about: 'walks a fixed beat; garrisons the objective wing; still fights and investigates',
    considerations: ['panic', 'threat', 'defendMyWing', 'pursueMemory', 'fleeMemory', 'investigate', 'garrison', 'patrol', 'workMyRoom', 'wander'],
  },
  hunter: {
    about: 'presses a chase to last-known position, then sweeps the area; holds its turf when idle',
    considerations: ['threat', 'defendMyWing', 'hunt', 'fleeMemory', 'investigate', 'garrison', 'workMyRoom', 'wander'],
  },
  skittish: {
    about: 'flees trouble, catches the crowd’s panic, and runs to the nearest guard to raise the alarm',
    considerations: ['alertGuards', 'fear', 'contagiousFear', 'threat', 'pursueMemory', 'fleeMemory', 'investigate', 'garrison', 'workMyRoom', 'wander'],
  },
  scavenger: {
    about: 'drawn to loose items it can see; grabs them into its stash',
    considerations: ['fear', 'contagiousFear', 'threat', 'fleeMemory', 'scavenge', 'workMyRoom', 'wander'],
  },
  infected: {
    about: '#64/#66: a spore-turned host — hunts the nearest clean body, else drifts toward the hive stimulus',
    considerations: ['infest', 'drawnToStimulus', 'pursueMemory', 'wander'],
  },
  vermin: {
    about: '#66: spore-vermin — attacks what it sees, else swarms toward the loudest/brightest stimulus',
    considerations: ['threat', 'drawnToStimulus', 'wander'],
  },
  predator: {
    about: '#67: a scavenger — culls the WEAKEST body in sight, flees a healthy pack, drifts to stimulus',
    considerations: ['packAvoid', 'stalkWeakest', 'drawnToStimulus', 'wander'],
  },
  mireclaw: {
    about: '#69 Mireclaw Alpha boss — phased: pressure & summon, retreat-to-spore-regen, then enrage',
    considerations: ['enrage', 'retreatToSpore', 'threat', 'hunt', 'wander'],
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

/** #62 — incumbent-goal hysteresis margin (a deadband). The goal an NPC ALREADY
 * holds (same code+target) gets its COMPARE score scaled up by this fraction, so
 * a rival goal must beat the standing one by a clear margin — not a hair — to
 * win. Kills the #59 battle<->flee reversal that a 1-hp spore-DOT/regen jitter
 * otherwise trips every think. Strictly WITHIN a tier: a higher TIER
 * (panic/threat over ambient) still preempts instantly, so responsiveness to a
 * real, new threat is unchanged. Shipped ON; A/B-disable via
 * `w.aiFlags.hysteresis === false`. `lastScores` stays RAW so the "why" trail is
 * honest — only arbitration sees the bonus. */
export const HYSTERESIS_MARGIN = 0.25

/** Run one think: evaluate the entity's behavior and pick the winning goal.
 * Highest tier wins; within a tier, strictly-greater EFFECTIVE score (the
 * incumbent gets the hysteresis bonus) in consideration / candidate order —
 * byte-for-byte deterministic. */
export const decide = (w: World, e: Entity): Decision => {
  const def = behaviorFor(e)
  const hyst = w.aiFlags?.hysteresis !== false // shipped ON; only an explicit false disables
  const incumbentCode = e.ai?.goal
  const incumbentTarget = e.ai?.targetId
  const isIncumbent = (c: Candidate): boolean =>
    c.code === incumbentCode && (c.target ?? undefined) === (incumbentTarget ?? undefined)
  // Effective compare score: raw, but the standing goal gets the hysteresis bonus.
  const eff = (c: Candidate): number => (hyst && isIncumbent(c) ? c.score * (1 + HYSTERESIS_MARGIN) : c.score)
  let best: Candidate = { code: WANDER, score: WANDER_SCORE, tier: TIER_AMBIENT }
  let bestEff = eff(best)
  const scores: Record<string, number> = {}
  for (const id of def.considerations) {
    const consider = CONSIDERATIONS[id]
    if (!consider) continue
    for (const c of consider(w, e)) {
      const top = scores[id]
      if (top === undefined || c.score > top) scores[id] = round3(c.score)
      const ce = eff(c)
      if (c.tier > best.tier || (c.tier === best.tier && ce > bestEff)) {
        best = c
        bestEff = ce
      }
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
