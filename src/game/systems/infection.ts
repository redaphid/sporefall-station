// #64 — Spore contagion → Infected hosts. The FLAGSHIP Sporefall mechanic: the
// environmental `spore` status stops being a pure DOT and becomes an AI DRIVER.
// A crew member who breathes too much spore TURNS into a mindless Infected host
// — hostile to every uninfected body, driven by the `infected` brain
// (systems/behaviors.ts `infest`), spreading spore on contact so a single bloom
// becomes an epidemic. Counterplay: FIRE burns the spores off before the turn.
//
// ⚠️ SHIPPED BEHIND A TOGGLE. `INFECTION_ENABLED` (below) defaults to FALSE —
// this changes game feel substantially, so it is OFF until the owner opts in,
// a build-time feature gate. While off, `infectionSystem` is never called,
// no entity is ever `infected`, and the brain's infection branch is skipped, so
// the shipped sim is byte-identical. A test/sim may force it per-world via
// `w.aiFlags.infection` (which wins over the toggle) without touching the flag.
//
// Determinism: threshold + fixed contact radius + ascending-id iteration + tick
// counter only — no Date/Math.random.

import { ELEMENTS } from '../data/elements'
import type { Entity } from '../entity'
import type { World } from '../world'
import { addStatus, hasStatus, removeStatus } from './statusFx'
import { vlen } from '../simMath'

// ─────────────────────────────────────────────────────────────────────────────
// OWNER TUNING — every lever for the outbreak lives here.
// ─────────────────────────────────────────────────────────────────────────────

/** ⚠️ The master switch. `false` = the shipped default (spore is a pure DOT,
 * nobody turns). Flip to `true` to enable the contagion everywhere, or leave it
 * off and enable per-world/mission via `w.aiFlags.infection = true`. */
export const INFECTION_ENABLED: boolean = false

/** Spore-exposure load at which a crew member turns. Exposure accrues +1/tick
 * while standing in the `spore` status; ~4s of cumulative exposure to turn.
 * Higher = more time to burn the bloom back before the crew converts. */
export const INFECT_THRESHOLD = 120

/** Contact radius (tiles) at which an Infected doses a clean body with spore —
 * the contagion vector, independent of the melee damage path. Bigger = hotter R0. */
export const CONTACT_RADIUS = 0.9

/** Spore dose an Infected lays on a body it is touching (tops up the status so
 * exposure keeps climbing while in contact). */
export const CONTACT_DOSE = ELEMENTS.spore.durationTicks

/** A turned host's speed multiplier and floor — a shamble, not a sprint, so the
 * crew can outrun a lone host (the spread comes from crowds + the bloom). */
export const HOST_SPEED_MULT = 0.7
export const HOST_SPEED_MIN = 1.5

// ─────────────────────────────────────────────────────────────────────────────

/** Is the contagion active for this world? A per-world override
 * (`w.aiFlags.infection`) wins; otherwise the module toggle decides. */
export const infectionActive = (w: World): boolean => w.aiFlags?.infection ?? INFECTION_ENABLED

/** Who can be infected: a living NPC with a brain and health, not already turned.
 * Players are left out of v1 (their infection would be a whole design of its own). */
const infectable = (e: Entity): boolean => !!e.ai && !!e.health && !e.dead && !e.infected

/** Flip a crew member into an Infected host: mindless `infected` brain, aggro
 * on, memory/relationships wiped, a shamble instead of a sprint, and a fresh
 * appetite for the nearest clean body. Emits an `aiGoal` event for legibility. */
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
  e.speed = Math.max(HOST_SPEED_MIN, e.speed * HOST_SPEED_MULT)
  w.events.push({ type: 'aiGoal', entityId: e.id, goal: 'infest', prev: ai.goal ?? 'none' })
}

export const infectionSystem = (w: World): void => {
  // 1. Exposure. Anyone standing in spore accrues load and turns at threshold —
  //    UNLESS they are on fire, which burns the spores off (the counterplay:
  //    torch the bloom or the crew before they convert). Runs after sporeSystem,
  //    so `spore` for this tick is already laid and `burning` already set.
  for (const e of w.entities) {
    if (!infectable(e)) continue
    if (hasStatus(e, 'burning')) {
      // Fire cure: clear the spore status and reset the accrued load.
      removeStatus(e, 'spore')
      e.sporeLoad = 0
      continue
    }
    if (hasStatus(e, 'spore')) {
      e.sporeLoad = (e.sporeLoad ?? 0) + 1
      if (e.sporeLoad >= INFECT_THRESHOLD) turnInfected(w, e)
    }
  }
  // 2. Contagion by contact. Every Infected doses nearby clean bodies with spore
  //    (they then accrue in step 1 → turn → dose others: an R0 chain). Ascending
  //    id order over a fixed pair scan keeps it byte-deterministic.
  for (const src of w.entities) {
    if (!src.infected || src.dead) continue
    for (const t of w.entities) {
      if (t === src || t.dead || !t.health || t.infected) continue
      if (!t.ai && !t.playerCtl) continue
      const d = vlen(t.pos.x - src.pos.x, t.pos.y - src.pos.y)
      if (d <= CONTACT_RADIUS + t.radius + src.radius) addStatus(w, t, 'spore', CONTACT_DOSE)
    }
  }
}
