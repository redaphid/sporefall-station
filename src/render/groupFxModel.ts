// Pure view-model for the raid set-pieces' tells: WHAT to draw, decided from
// the RenderView alone. The pixi layer (groupFx.ts) only draws its output.
//
//   charges   — a sapper's planted charge on a door: a blinking light that
//               blinks faster as the fuse burns, a blast-radius ring and a
//               countdown, from the `sapperCharge` event until it goes off
//   blasts    — the shockwave ring when a charged door is blown (`doorBreach`)
//   beams     — a medic's heal: a beam from the Bog Mender to whoever it
//               patched, for a beat after each `heal` event
//   retreaters— a raider falling back to the medic (`ai.healing`) wears a
//               green cross, so "running away" reads as "running to be healed"
//   medics    — a faint ring under each Bog Mender, so the player can find it
//
// Before this, none of the group layer's events were drawn: the charge was
// invisible until the door simply vanished in a generic explosion, and heals
// were numbers changing on bodies the player could not inspect. Presentational
// only — never touches the sim; ticks, not wall-clock, so a replay draws the same.

import type { RenderView } from '../app/session'
import { SAPPER_BLAST_RADIUS } from '../game/systems/groups'
import { SIM_RATE } from '../game/types'

export interface ChargeFx {
  doorId: number
  x: number
  y: number
  /** Blast-radius ring, tiles. */
  radius: number
  /** Ticks left on the fuse (>0). */
  ticksLeft: number
  /** Whole fuse length, ticks. */
  fuse: number
  /** Is the blinking light lit this tick? */
  lit: boolean
  /** Countdown label, e.g. "1.2". */
  label: string
}

export interface BlastFx {
  x: number
  y: number
  /** Current ring radius, tiles. */
  radius: number
  /** 0..1 */
  alpha: number
}

export interface BeamFx {
  x1: number
  y1: number
  x2: number
  y2: number
  /** 0..1 */
  alpha: number
}

export interface GroupFxUi {
  charges: ChargeFx[]
  blasts: BlastFx[]
  beams: BeamFx[]
  retreaters: { x: number; y: number }[]
  medics: { x: number; y: number }[]
}

/** How long a heal beam lingers after its pulse. */
export const BEAM_TICKS = 18
/** How long the breach shockwave ring expands. */
export const BLAST_TICKS = 16
/** The shockwave's final radius, tiles. */
export const BLAST_REACH = 2.6

/** Blink half-period for a fuse with `left` of `fuse` ticks to go: a slow
 * 6-tick blink when freshly planted, down to every tick at the end. */
export const blinkHalfPeriod = (left: number, fuse: number): number =>
  Math.max(1, Math.round(1 + 5 * Math.min(1, Math.max(0, left / Math.max(1, fuse)))))

interface Charge {
  doorId: number
  x: number
  y: number
  at: number
  fuse: number
}

export interface GroupFxTracker {
  update(view: Pick<RenderView, 'tick' | 'events' | 'entities'>): GroupFxUi
}

export const createGroupFxTracker = (): GroupFxTracker => {
  let charges: Charge[] = []
  let blasts: { x: number; y: number; at: number }[] = []
  let beams: { from: number; to: number; at: number }[] = []
  let lastTick = -1

  return {
    update(view) {
      const tick = view.tick
      if (tick !== lastTick) {
        // A rewind (state restore, restart) invalidates everything in flight.
        if (tick < lastTick) {
          charges = []
          blasts = []
          beams = []
        }
        lastTick = tick
        for (const ev of view.events) {
          if (ev.type === 'sapperCharge') {
            charges = charges.filter((c) => c.doorId !== ev.doorId)
            charges.push({ doorId: ev.doorId, x: ev.x, y: ev.y, at: tick, fuse: ev.fuse })
          } else if (ev.type === 'doorBreach') {
            const blown = charges.some((c) => c.doorId === ev.entityId)
            charges = charges.filter((c) => c.doorId !== ev.entityId)
            if (blown) blasts.push({ x: ev.x, y: ev.y, at: tick })
          } else if (ev.type === 'heal') {
            beams.push({ from: ev.byId, to: ev.entityId, at: tick })
          }
        }
        // A fuse that ran out without a breach (the door was opened another
        // way) still stops drawing: the charge is spent.
        charges = charges.filter((c) => tick < c.at + c.fuse)
        blasts = blasts.filter((b) => tick < b.at + BLAST_TICKS)
        beams = beams.filter((b) => tick < b.at + BEAM_TICKS)
      }

      const byId = new Map(view.entities.map((e) => [e.id, e]))
      const ui: GroupFxUi = { charges: [], blasts: [], beams: [], retreaters: [], medics: [] }
      for (const c of charges) {
        const left = c.at + c.fuse - tick
        const half = blinkHalfPeriod(left, c.fuse)
        ui.charges.push({
          doorId: c.doorId,
          x: c.x,
          y: c.y,
          radius: SAPPER_BLAST_RADIUS,
          ticksLeft: left,
          fuse: c.fuse,
          lit: Math.floor((tick - c.at) / half) % 2 === 0,
          label: (left / SIM_RATE).toFixed(1),
        })
      }
      for (const b of blasts) {
        const p = (tick - b.at) / BLAST_TICKS
        ui.blasts.push({ x: b.x, y: b.y, radius: 0.4 + p * (BLAST_REACH - 0.4), alpha: 1 - p })
      }
      for (const b of beams) {
        const from = byId.get(b.from)
        const to = byId.get(b.to)
        if (!from || !to || from.dead || to.dead) continue
        ui.beams.push({ x1: from.pos.x, y1: from.pos.y, x2: to.pos.x, y2: to.pos.y, alpha: 1 - (tick - b.at) / BEAM_TICKS })
      }
      for (const e of view.entities) {
        if (e.dead || !e.ai?.group) continue
        if (e.ai.healing) ui.retreaters.push({ x: e.pos.x, y: e.pos.y })
        if (e.ai.group.role === 'medic') ui.medics.push({ x: e.pos.x, y: e.pos.y })
      }
      return ui
    },
  }
}
