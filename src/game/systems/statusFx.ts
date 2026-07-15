// The generic status/element framework. Effects attach to an entity's `fx`
// component, tick, and expire on their own; reapplying one restarts its clock.
// Each entry stores an ABSOLUTE expiry tick (`until = world.tick + duration`),
// never a mutable countdown — so expiry is a pure function of world.tick and a
// mid-effect snapshot restores with nothing to fix up. Mirrors brain's `fx`.

import type { Entity } from '../entity'
import type { EntityId } from '../types'
import type { World } from '../world'

/** Attach `kind` to `e`, expiring `durationTicks` from now. Refreshes an
 * existing effect. Dead entities gain nothing; non-positive durations no-op. */
export const addStatus = (w: World, e: Entity, kind: string, durationTicks: number, source?: EntityId): void => {
  if (e.dead) return
  if (!(durationTicks > 0)) return
  const fx = (e.fx ??= {})
  fx[kind] = { until: w.tick + durationTicks, source }
}

export const removeStatus = (e: Entity, kind: string): void => {
  if (e.fx) delete e.fx[kind]
}

export const hasStatus = (e: Entity, kind: string): boolean => e.fx !== undefined && e.fx[kind] !== undefined

/** Apply one status to one entity — the single place item/element effects land.
 * `sleep` and `slip`/`stun` route to the proven legacy per-tick timers (which
 * already immobilize and wake-on-damage); everything else is an fx effect. */
export const applyStatus = (w: World, e: Entity, status: string, ticks: number): void => {
  if (status === 'sleep') {
    if (e.status) e.status.sleep = ticks
    return
  }
  if (status === 'slip' || status === 'stun') {
    if (e.status) e.status.stun = ticks
    return
  }
  addStatus(w, e, status, ticks)
}

export const isFrozen = (e: Entity): boolean => hasStatus(e, 'frozen')

export const isWet = (e: Entity): boolean => hasStatus(e, 'wet')

/** Frozen or electrified: the game's `CantDoAnything` states — a body that can
 * neither move nor act until the status runs out. Movement, combat and AI all
 * gate on this. */
export const isImmobilized = (e: Entity): boolean => hasStatus(e, 'frozen') || hasStatus(e, 'electrified')

/** Expire every effect whose tick has arrived. Pure function of world.tick, so
 * it behaves identically whether the world ran unbroken or was restored. */
export const statusFxSystem = (w: World): void => {
  for (const e of w.entities) {
    if (!e.fx) continue
    for (const kind of Object.keys(e.fx)) {
      if (e.fx[kind].until <= w.tick) delete e.fx[kind]
    }
  }
}
