import type { RenderView } from '../app/session'
import type { ItemStack } from '../game/entity'
import { emptyInput, type InputCmd } from '../game/types'
import { hotbarSlots } from '../ui/hotbarModel'
import { selectAim } from './aim'
import { assignPads } from './padAssign'
import { padProfile } from './padProfile'
import { readPad, type PadState } from './readPad'

/**
 * Local co-op over the Gamepad API. One instance owns every connected pad,
 * press-to-join assigns each to a stable player slot, and sample() returns the
 * per-player InputCmds plus join/leave/pause events for the session to act on.
 * All state lives here; the pure pieces (profile, readPad, assignPads) stay
 * testable in isolation.
 */
export interface CoopDebugPad {
  padIndex: number
  id: string
  slot: number | null
  state: PadState
}

export interface CoopSample {
  inputs: Map<number, InputCmd>
  joins: number[]
  leaves: number[]
  pauses: number[]
}

type GetPads = () => (Gamepad | null)[]

const idle: PadState = {
  moveX: 0,
  moveY: 0,
  aimX: 0,
  aimY: 0,
  attack: false,
  interact: false,
  special: false,
  roll: false,
  pause: false,
  throwItem: false,
  hotbarPrev: false,
  hotbarNext: false,
}

/**
 * Resolve a prev/next weapon-cycle intent into an ABSOLUTE inventory slot index
 * (the value InputCmd.hotbar carries and the host equips), or -1 when there's
 * nothing to switch to. Pure so it's unit-testable. Cycles over the same
 * briefcase-filtered display slots the touch hotbar shows, wrapping at the ends;
 * from bare fists (activeSlot not in the list) it starts at the first/last slot.
 */
export const cycleHotbar = (inv: ItemStack[], activeSlot: number, dir: 1 | -1): number => {
  const slots = hotbarSlots(inv, activeSlot)
  if (slots.length === 0) return -1
  const cur = slots.findIndex((s) => s.index === activeSlot)
  if (cur === -1) return dir > 0 ? slots[0].index : slots[slots.length - 1].index
  const next = (cur + dir + slots.length) % slots.length
  return slots[next].index
}

/** Is any pad press-to-joined into a player slot? (A merely-connected-but-
 * unjoined pad doesn't count.) One input to the touch-controls show/hide
 * policy — the full rule matrix lives in stickVisibility.ts. */
export const anyPadActive = (pads: readonly CoopDebugPad[]): boolean => pads.some((p) => p.slot !== null)

export const createGamepadCoop = (getPads: GetPads = () => navigator.getGamepads?.() ?? []) => {
  let assignments = new Map<number, number>()
  const last = new Map<number, PadState>()
  // Per player-slot inventory snapshot, refreshed each frame by update(view).
  // The weapon-cycle resolver reads it to turn a prev/next press into a concrete
  // slot; empty until the first update, so an early press is a harmless no-op.
  const hotbarBySlot = new Map<number, { inv: ItemStack[]; activeSlot: number }>()
  let debugPads: CoopDebugPad[] = []
  let seq = 0

  const rose = (padIndex: number, now: PadState, field: keyof PadState): boolean => {
    const was = last.get(padIndex) ?? idle
    return Boolean(now[field]) && !was[field]
  }

  const toCmd = (padIndex: number, slot: number, s: PadState): InputCmd => {
    const cmd = emptyInput()
    cmd.seq = seq++
    cmd.moveX = s.moveX
    cmd.moveY = s.moveY
    cmd.attack = s.attack
    cmd.interact = rose(padIndex, s, 'interact')
    cmd.special = s.special
    cmd.roll = rose(padIndex, s, 'roll') // edge: one roll per press, no auto-repeat
    cmd.throwItem = rose(padIndex, s, 'throwItem') // edge: one throw per press
    // Weapon switch: a prev/next EDGE resolves to an absolute slot via the cached
    // inventory, so it round-trips the wire exactly like the touch hotbar edge.
    const hb = hotbarBySlot.get(slot)
    if (hb) {
      if (rose(padIndex, s, 'hotbarNext')) cmd.hotbar = cycleHotbar(hb.inv, hb.activeSlot, 1)
      else if (rose(padIndex, s, 'hotbarPrev')) cmd.hotbar = cycleHotbar(hb.inv, hb.activeSlot, -1)
    }
    // Right stick aims (twin-stick); falls back to aim-where-you-move.
    const aim = selectAim(s.moveX, s.moveY, s.aimX, s.aimY)
    cmd.aimX = aim.x
    cmd.aimY = aim.y
    return cmd
  }

  const sample = (): CoopSample => {
    const pads = getPads()
    const live = pads.filter((p): p is Gamepad => p !== null)
    const states = new Map<number, PadState>()
    for (const p of live) states.set(p.index, readPad(p, padProfile(p)))

    const connected = live.map((p) => p.index)
    const joining = live
      .filter((p) => padProfile(p).join.some((i) => p.buttons[i]?.pressed))
      .map((p) => p.index)
      .filter((i) => !assignments.has(i))

    const result = assignPads(assignments, connected, joining)
    assignments = result.assignments
    // The press that JOINS a pad is spent on joining: it must not double as a
    // game action on the same sample. Start is both a join button and the pause
    // button, so without this a player pressing Start to join instantly paused
    // the game (and a face-button join fired an attack). Reading the joining
    // pad as idle for THIS sample only — while still recording its real state
    // into `last` below — keeps the held button from edge-firing later too.
    const joinedNow = new Set(result.events.filter((e) => e.type === 'join').map((e) => e.padIndex))

    const inputs = new Map<number, InputCmd>()
    const pauses: number[] = []
    for (const [padIndex, slot] of assignments) {
      const s = joinedNow.has(padIndex) ? idle : (states.get(padIndex) ?? idle)
      inputs.set(slot, toCmd(padIndex, slot, s))
      if (rose(padIndex, s, 'pause')) pauses.push(slot)
    }

    debugPads = live.map((p) => ({
      padIndex: p.index,
      id: p.id,
      slot: assignments.has(p.index) ? assignments.get(p.index)! : null,
      state: states.get(p.index) ?? idle,
    }))

    for (const p of live) last.set(p.index, states.get(p.index) ?? idle)
    for (const key of [...last.keys()]) if (!connected.includes(key)) last.delete(key)

    const joins = result.events.filter((e) => e.type === 'join').map((e) => e.slot)
    const leaves = result.events.filter((e) => e.type === 'leave').map((e) => e.slot)
    return { inputs, joins, leaves, pauses }
  }

  const debug = (): CoopDebugPad[] => debugPads

  /** Cache each player's inventory/activeSlot from the render view so the next
   * sample() can resolve a weapon-cycle press into a concrete slot. Called once
   * per frame (like touch.update); one-frame staleness is harmless. */
  const update = (view: RenderView): void => {
    hotbarBySlot.clear()
    for (const e of view.entities) {
      const ctl = e.playerCtl
      if (!ctl) continue
      hotbarBySlot.set(ctl.playerId, { inv: ctl.inventory, activeSlot: ctl.activeSlot })
    }
  }

  return { sample, debug, update }
}
