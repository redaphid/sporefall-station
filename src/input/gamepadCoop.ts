import { emptyInput, type InputCmd } from '../game/types'
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
}

export const createGamepadCoop = (getPads: GetPads = () => navigator.getGamepads?.() ?? []) => {
  let assignments = new Map<number, number>()
  const last = new Map<number, PadState>()
  let debugPads: CoopDebugPad[] = []
  let seq = 0

  const rose = (padIndex: number, now: PadState, field: keyof PadState): boolean => {
    const was = last.get(padIndex) ?? idle
    return Boolean(now[field]) && !was[field]
  }

  const toCmd = (padIndex: number, s: PadState): InputCmd => {
    const cmd = emptyInput()
    cmd.seq = seq++
    cmd.moveX = s.moveX
    cmd.moveY = s.moveY
    cmd.attack = s.attack
    cmd.interact = rose(padIndex, s, 'interact')
    cmd.special = s.special
    cmd.roll = rose(padIndex, s, 'roll') // edge: one roll per press, no auto-repeat
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

    const inputs = new Map<number, InputCmd>()
    const pauses: number[] = []
    for (const [padIndex, slot] of assignments) {
      const s = states.get(padIndex) ?? idle
      inputs.set(slot, toCmd(padIndex, s))
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

  return { sample, debug }
}
