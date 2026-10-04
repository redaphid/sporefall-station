// The toast a sealed hatch gives the player who presses it, or walks into it,
// without its key: what opens it, and that a breach always does. Pure text for
// the DOM toast in screens.ts, rate-limited so leaning on the door or mashing
// the button doesn't spam.
//
// The press reaches every peer as a `sealDenied` event. The walk-in is read off
// the door entity, which carries its seal only on the host: the wire sends a
// door's open/locked bits, not its seal kind, so a joiner gets the press hint
// and not the walk-in one.

import type { RenderView } from '../app/session'
import type { Entity } from '../game/entity'
import { SPECIAL_NAME } from '../game/player'
import { hasKeycard } from '../game/systems/interaction'
import type { SimEvent } from '../game/types'

export type SealKind = Extract<SimEvent, { type: 'sealDenied' }>['sealKind']

/** Fewest sim ticks between two seal hints (3 s at 30 tps). */
export const SEAL_HINT_COOLDOWN_TICKS = 90

/** What opens each seal, besides a breach. */
const KEY_STEP: Record<SealKind, (nameOf: (archetype: string) => string) => string> = {
  keycard: () => 'Sealed. Find the keycard',
  power: (nameOf) => `Sealed. Hack the ${nameOf('generator')}`,
  overgrown: (nameOf) => `Overgrown. Kill its ${nameOf('sporeNode')}`,
}

export const sealHintText = (kind: SealKind, nameOf: (archetype: string) => string): string =>
  `${KEY_STEP[kind](nameOf)}, or blast it with a ${SPECIAL_NAME}`

/** The seal on a shut door, if it has one. A plain lock is not a seal. */
const sealOf = (d: Entity): SealKind | undefined => {
  if (!d.door || d.door.open) return undefined
  if (d.door.overgrown) return 'overgrown'
  if (!d.door.locked) return undefined
  return d.door.sealKind === 'keycard' || d.door.sealKind === 'power' ? d.door.sealKind : undefined
}

/** Slack on contact: a body pushing into a shut door stops flush against it. */
const TOUCH_SLACK = 0.05

/** The sealed door `self` is pressed against and can't open, if any. */
const sealedDoorTouched = (entities: readonly Entity[], self: Entity): Entity | undefined =>
  entities.find((d) => {
    const kind = sealOf(d)
    if (!kind || (kind === 'keycard' && hasKeycard(self, d.door!.keyId))) return false
    const tx = Math.floor(d.pos.x)
    const ty = Math.floor(d.pos.y)
    const nx = Math.max(tx, Math.min(tx + 1, self.pos.x))
    const ny = Math.max(ty, Math.min(ty + 1, self.pos.y))
    return Math.hypot(self.pos.x - nx, self.pos.y - ny) <= self.radius + TOUCH_SLACK
  })

export interface SealHint {
  /** The toast to show this frame, or undefined. */
  update(view: Pick<RenderView, 'tick' | 'events' | 'self' | 'entities'>): string | undefined
}

export const createSealHint = (nameOf: (archetype: string) => string): SealHint => {
  let lastEventTick = -1
  let shownAt = -Infinity
  let leaningOn: number | undefined
  return {
    update(view) {
      const self = view.self
      if (!self) return undefined
      let kind: SealKind | undefined
      if (view.tick !== lastEventTick) {
        lastEventTick = view.tick
        for (const ev of view.events) if (ev.type === 'sealDenied' && ev.byId === self.id) kind = ev.sealKind
      }
      // Walking into the door hints once on contact, not every frame of leaning.
      const door = sealedDoorTouched(view.entities, self)
      if (door && door.id !== leaningOn) kind ??= sealOf(door)
      leaningOn = door?.id
      if (!kind || view.tick - shownAt < SEAL_HINT_COOLDOWN_TICKS) return undefined
      shownAt = view.tick
      return sealHintText(kind, nameOf)
    },
  }
}
