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
