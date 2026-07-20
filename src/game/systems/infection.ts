// PROTOTYPE (feat/sporefall-ai worktree) — spore contamination / contagion.
//
// Turns the environmental `spore` status from a pure DOT into an AI DRIVER: a
// crew member who accumulates enough spore exposure TURNS into a mindless
// Infected host — hostile to every uninfected body, driven by the `infected`
// brain (systems/behaviors.ts `infest`), spreading spore on contact so the
// infection propagates crew-to-crew. Deterministic: threshold + fixed contact
// radius, no Date/Math.random. Flag-gated (`world.proto.infection`) and called
// from tickWorld only when set, so the shipped sim is untouched.

import type { Entity } from '../entity'
import type { World } from '../world'
import { ELEMENTS } from '../data/elements'
import { hasStatus, addStatus } from './statusFx'

/** Spore-exposure load at which a crew member turns. Exposure accrues +1/tick
 * while standing in the `spore` status; ~4s of cumulative exposure to turn. */
export const INFECT_THRESHOLD = 120
/** Contact radius (tiles): an Infected within this of a clean body seeds spore
 * on it — the contagion vector, independent of the melee damage path. */
const CONTACT_RADIUS = 0.9
/** Spore dose an Infected lays on a body it is touching (tops up the status so
 * exposure keeps climbing while in contact). */
const CONTACT_DOSE = ELEMENTS.spore.durationTicks

/** Can this entity be infected? Living NPC crew (has ai + health). Players are
 * left out of the prototype (their infection would be a whole design of its own). */
const infectable = (e: Entity): boolean => !!e.ai && !!e.health && !e.dead && !e.infected

/** Flip a crew member to an Infected host: mindless `infected` brain, aggro on,
 * memory/relationships wiped, a fresh appetite for the nearest clean body. */
export const turnInfected = (w: World, e: Entity): void => {
  e.infected = true
  const ai = e.ai!
  ai.behavior = 'infected'
  ai.mode = 'aggro'
  ai.rel = {}
  ai.targetId = undefined
  ai.lastKnownTargetPos = undefined
  ai.search = undefined
  ai.thinkAt = w.tick
  e.speed = Math.max(1.5, e.speed * 0.7) // a shamble, not a sprint
  w.events.push({ type: 'aiGoal', entityId: e.id, goal: 'infest', prev: ai.goal ?? 'none' })
}

export const infectionSystem = (w: World): void => {
  // 1. Accrue exposure for anyone standing in spore; turn at threshold.
  for (const e of w.entities) {
    if (!infectable(e)) continue
    if (hasStatus(e, 'spore')) {
      e.sporeLoad = (e.sporeLoad ?? 0) + 1
      if (e.sporeLoad >= INFECT_THRESHOLD) turnInfected(w, e)
    }
  }
  // 2. Contagion by contact: every Infected doses nearby clean bodies with spore
  //    (they then accrue exposure in step 1 → turn → dose others: an R0 chain).
  for (const src of w.entities) {
    if (!src.infected || src.dead) continue
    for (const t of w.entities) {
      if (t === src || t.dead || !t.health || t.infected) continue
      if (!t.ai && !t.playerCtl) continue
      const d = Math.hypot(t.pos.x - src.pos.x, t.pos.y - src.pos.y)
      if (d <= CONTACT_RADIUS + t.radius + src.radius) addStatus(w, t, 'spore', CONTACT_DOSE)
    }
  }
}
