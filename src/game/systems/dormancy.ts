// #68 — dormancy + stimulus-trigger. A first-class replacement for the one
// hardcoded "robot wakes on power-cut" special case: any entity can spawn
// `dormant` (inert — no move, no target) with a `wakeOn` list of stimulus kinds,
// and the awakeningSystem flips it active the moment a matching stimulus crosses
// a threshold nearby, emitting a `woke` event. This is the stealth/set-piece
// layer — a room of dormant pods you tiptoe past, or trip and run.
//
// Stimulus kinds: 'noise' | 'spore' | 'fire' (the shared stimulus field,
// systems/stimulus.ts) · 'proximity' (a body of another faction strays close) ·
// 'damage' (it was hit) · 'power-cut'. Deterministic: threshold checks on
// tick-based stimulus state, ascending-id iteration, no Date/Math.random.

import type { Entity } from '../entity'
import { anyPowerCut, type World } from '../world'
import { gatherStimuli } from './stimulus'

/** How close a noise/fire/spore stimulus must be to trip a dormant entity. */
export const WAKE_STIMULUS_RANGE = 7
/** How close a foreign body must stray to trip a `proximity` sleeper. */
export const WAKE_PROXIMITY_RANGE = 3
/** A hit within this many ticks trips a `damage` sleeper. */
export const WAKE_DAMAGE_TICKS = 20
/** An OPEN door within this range trips a `door` sleeper (the lurker hears its
 * room being entered). Doors spawn closed, so this arms the moment one opens. */
export const WAKE_DOOR_RANGE = 4

/** Is a living body of a DIFFERENT faction within `range` (players have none →
 * always count)? — the proximity trip. */
const bodyNear = (w: World, e: Entity, range: number): boolean => {
  for (const p of w.entities) {
    if (p === e || p.dead || !p.health) continue
    if (!p.playerCtl && !p.ai) continue
    if (p.ai?.faction === e.ai!.faction) continue // its own kind doesn't wake it
    if (Math.hypot(p.pos.x - e.pos.x, p.pos.y - e.pos.y) <= range) return true
  }
  return false
}

/** Which wake trigger (if any) fires for this dormant entity this tick. */
const wakeTrigger = (w: World, e: Entity, stimuli: ReturnType<typeof gatherStimuli>): string | undefined => {
  const kinds = e.ai!.wakeOn
  if (!kinds || kinds.length === 0) return undefined
  if (kinds.includes('power-cut') && anyPowerCut(w)) return 'power-cut'
  if (kinds.includes('proximity') && bodyNear(w, e, WAKE_PROXIMITY_RANGE)) return 'proximity'
  if (
    kinds.includes('damage') &&
    e.health?.lastHurtTick !== undefined &&
    w.tick - e.health.lastHurtTick <= WAKE_DAMAGE_TICKS
  )
    return 'damage'
  // An opened door nearby — the lurker's room was just entered.
  if (kinds.includes('door')) {
    for (const d of w.entities) {
      if (d.door?.open && !d.dead && Math.hypot(d.pos.x - e.pos.x, d.pos.y - e.pos.y) <= WAKE_DOOR_RANGE)
        return 'door'
    }
  }
  // Environmental stimuli (noise / fire / spore) within range.
  for (const s of stimuli) {
    if (!kinds.includes(s.kind)) continue
    if (Math.hypot(s.x - e.pos.x, s.y - e.pos.y) <= WAKE_STIMULUS_RANGE) return s.kind
  }
  return undefined
}

export const awakeningSystem = (w: World): void => {
  let stimuli: ReturnType<typeof gatherStimuli> | undefined
  for (const e of w.entities) {
    if (e.dead || !e.ai?.dormant) continue
    stimuli ??= gatherStimuli(w) // built once, only if there's a sleeper to check
    const by = wakeTrigger(w, e, stimuli)
    if (!by) continue
    e.ai.dormant = false
    e.ai.mode = 'aggro'
    e.ai.thinkAt = w.tick // think (and act) this very tick
    w.events.push({ type: 'woke', entityId: e.id, by })
  }
}
