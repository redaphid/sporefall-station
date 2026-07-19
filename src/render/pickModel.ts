// Pure view-model for the lockpick affordance: WHAT to draw, decided from the
// RenderView alone — the pixi layer in renderer.ts just draws it. Three parts:
//   ring    — progress ring over the door while a pick channel runs
//   prompt  — "Lock II · Use to pick (3.5s) · stand still" over a nearby
//             locked door BEFORE the player commits
//   toast   — a short "Pick broken — hold still!" / "hit!" flash when a
//             channel is cancelled, so a failed pick is never silent
//
// Works on host AND net client: the host/solo path reads the exact channel off
// view.self; a joiner has no sim channel, so the tracker follows the pickStart/
// pickCancel/doorToggle/doorBreach events instead (they ride EventsMsg) and
// interpolates progress by tick. Purely presentational — never touches the sim.

import type { RenderView } from '../app/session'
import type { Entity } from '../game/entity'
import { nearestInteractable, PICK_TICKS_BY_LEVEL, pickTicks } from '../game/systems/interaction'
import { SIM_RATE } from '../game/types'

export interface PickRing {
  doorId: number
  x: number
  y: number
  /** 0..1 fraction of the channel done. */
  progress: number
}

export interface PickPrompt {
  doorId: number
  x: number
  y: number
  text: string
}

export interface PickToast {
  x: number
  y: number
  text: string
  /** 0..1 remaining life (drives fade-out). */
  life: number
}

export interface PickUi {
  ring?: PickRing
  prompt?: PickPrompt
  toast?: PickToast
}

const TOAST_TICKS = 60
const ROMAN = ['0', 'I', 'II', 'III', 'IV']

const CANCEL_TEXT: Record<'moved' | 'hurt' | 'gone', string | null> = {
  moved: 'Pick broken — stand still!',
  hurt: 'Pick broken — you got hit!',
  gone: null, // the door opened some other way; nothing to mourn
}

export const promptText = (lockLevel: number): string => {
  // Same clamp as pickTicks, so the numeral always matches the quoted time.
  const lvl = Math.max(1, Math.min(PICK_TICKS_BY_LEVEL.length - 1, Math.floor(lockLevel)))
  return `Lock ${ROMAN[lvl]} · Use to pick (${(pickTicks(lvl) / SIM_RATE).toFixed(1)}s)`
}

/** Stateful across frames (client-side event tracking + toast decay). */
export interface PickTracker {
  update(view: RenderView): PickUi
}

export const createPickTracker = (): PickTracker => {
  let lastEventTick = -1
  /** Event-derived channel estimate (net client path). */
  let est: { doorId: number; startTick: number; total: number } | undefined
  let toast: { x: number; y: number; text: string; untilTick: number } | undefined

  const consumeEvents = (view: RenderView): void => {
    if (view.tick === lastEventTick) return
    lastEventTick = view.tick
    const selfId = view.self?.id
    for (const ev of view.events) {
      if (ev.type === 'pickStart' && ev.byId === selfId) {
        est = { doorId: ev.entityId, startTick: view.tick, total: ev.ticks }
      } else if (ev.type === 'pickCancel' && ev.byId === selfId) {
        if (est?.doorId === ev.entityId) est = undefined
        const door = view.entities.find((e) => e.id === ev.entityId)
        const text = CANCEL_TEXT[ev.reason]
        if (door && text) toast = { x: door.pos.x, y: door.pos.y, text, untilTick: view.tick + TOAST_TICKS }
      } else if ((ev.type === 'doorToggle' || ev.type === 'doorBreach') && est?.doorId === ev.entityId) {
        est = undefined
      }
    }
  }

  const ringFor = (view: RenderView): PickRing | undefined => {
    const self = view.self
    // Exact channel (host/solo): authoritative ticks, no interpolation.
    const ch = self?.playerCtl?.channel
    if (ch?.kind === 'lockpick') {
      const door = view.entities.find((e) => e.id === ch.targetId)
      if (door) {
        return { doorId: door.id, x: door.pos.x, y: door.pos.y, progress: 1 - ch.ticksLeft / ch.total }
      }
      return undefined
    }
    // Event-tracked estimate (net client): advance by tick, clamp shy of full —
    // the real completion arrives as a doorToggle.
    if (est) {
      const door = view.entities.find((e) => e.id === est!.doorId)
      if (!door || door.door?.open) {
        est = undefined
        return undefined
      }
      const progress = Math.min(0.98, (view.tick - est.startTick) / est.total)
      return { doorId: door.id, x: door.pos.x, y: door.pos.y, progress }
    }
    return undefined
  }

  const promptFor = (view: RenderView): PickPrompt | undefined => {
    const self = view.self
    if (!self) return undefined
    const target: Entity | null = nearestInteractable(view.entities, self)
    if (!target?.door || target.door.open || !target.door.locked) return undefined
    return { doorId: target.id, x: target.pos.x, y: target.pos.y, text: promptText(target.door.lockLevel) }
  }

  return {
    update(view: RenderView): PickUi {
      consumeEvents(view)
      const ring = ringFor(view)
      const ui: PickUi = { ring }
      // Prompt only while NOT channeling — during the pick the ring speaks.
      if (!ring) ui.prompt = promptFor(view)
      if (toast) {
        const left = toast.untilTick - view.tick
        if (left <= 0) toast = undefined
        else ui.toast = { x: toast.x, y: toast.y, text: toast.text, life: left / TOAST_TICKS }
      }
      return ui
    },
  }
}
