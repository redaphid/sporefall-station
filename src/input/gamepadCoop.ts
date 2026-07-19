import type { RenderView } from '../app/session'
import type { ItemStack } from '../game/entity'
import { emptyInput, type InputCmd } from '../game/types'
import { hotbarSlots } from '../ui/hotbarModel'
import { selectAim } from './aim'
import { assignPads } from './padAssign'
import { initialJoinIntent, stepJoinIntent, type JoinIntentState } from './padJoin'
import { padProfile } from './padProfile'
import { readPad, type PadState } from './readPad'
import { isPadCaptureActive, remapProfile } from './remap'

/**
 * Local co-op over the Gamepad API. One instance owns every connected pad,
 * ANY input joins — any button, or a firm proven stick push (rules in
 * padJoin.ts) — assigning the pad to a stable player slot; sample() returns
 * the per-player InputCmds plus join/leave/pause events for the session to act
 * on. All state lives here; the pure pieces (profile, readPad, padJoin,
 * assignPads) stay testable in isolation.
 *
 * Browser reality check: Chromium and Firefox hide a pad from
 * navigator.getGamepads() until its first interaction (fingerprinting
 * protection — see padJoin.ts). So the very first button press on a
 * just-plugged-in pad may be spent surfacing the pad to us at all. Once it is
 * visible, this module guarantees the rest: whatever input arrives first joins
 * the pad and stays INERT until released.
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

/** The button-shaped PadState fields — the ones join suppression can mask. */
const BOOL_FIELDS = [
  'attack',
  'interact',
  'special',
  'roll',
  'pause',
  'throwItem',
  'hotbarPrev',
  'hotbarNext',
] as const
type BoolField = (typeof BOOL_FIELDS)[number]

export const createGamepadCoop = (getPads: GetPads = () => navigator.getGamepads?.() ?? []) => {
  let assignments = new Map<number, number>()
  const last = new Map<number, PadState>()
  /** Per-unjoined-pad stick-join tracker (neutral proof + sustain). */
  const joinTrackers = new Map<number, JoinIntentState>()
  /** Buttons that were held at the moment a pad joined. Masked to false until
   * each is physically RELEASED — see the inert-join comment in sample(). */
  const suppressedAtJoin = new Map<number, Set<BoolField>>()
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

  /** The inert-join mask: while any button that was held AT the join is STILL
   * held, read it as unpressed. Cleared per-field on physical release, so the
   * next fresh press acts normally. */
  const maskSuppressed = (padIndex: number, real: PadState): PadState => {
    const sup = suppressedAtJoin.get(padIndex)
    if (!sup) return real
    for (const f of [...sup]) if (!real[f]) sup.delete(f)
    if (sup.size === 0) {
      suppressedAtJoin.delete(padIndex)
      return real
    }
    const masked = { ...real }
    for (const f of sup) masked[f] = false
    return masked
  }

  const sample = (): CoopSample => {
    const pads = getPads()
    const live = pads.filter((p): p is Gamepad => p !== null)
    const states = new Map<number, PadState>()
    // remapProfile overlays the user's button map (settings → Controller) on
    // the resolved profile, so a rebind applies on this very sample.
    for (const p of live) states.set(p.index, readPad(p, remapProfile(padProfile(p))))

    // While the remap UI is CAPTURING a button, every pad is presented idle
    // and nothing joins: the captured press is spent on binding (same rule as
    // the join press). Real states still land in `last` below, so releasing
    // the captured button after capture ends never edge-fires an action.
    const capturing = isPadCaptureActive()

    const connected = live.map((p) => p.index)
    // Join intent (padJoin.ts): ANY button, or a firm sustained push on a
    // trusted, proven-neutral stick pair. Trackers only exist for unjoined
    // pads — they accumulate the neutral proof across samples. While the remap
    // UI is capturing, nothing joins at all: the captured press is spent on
    // binding (trackers freeze rather than step, so no intent accrues either).
    const joining: number[] = []
    for (const p of live) {
      if (assignments.has(p.index)) {
        joinTrackers.delete(p.index)
        continue
      }
      if (capturing) continue
      const intent = stepJoinIntent(joinTrackers.get(p.index) ?? initialJoinIntent(), p, padProfile(p))
      joinTrackers.set(p.index, intent.state)
      if (intent.join) joining.push(p.index)
    }

    const result = assignPads(assignments, connected, joining)
    assignments = result.assignments
    // The input that JOINS a pad is spent on joining: it must not double as a
    // game action — not on this sample AND NOT WHILE IT STAYS HELD. Start is
    // both a join button and the pause button; X/Y are the special (grenade)
    // buttons; attack/special are LEVEL-triggered in the sim, so merely reading
    // the pad as idle for the joining sample is not enough — a human's join
    // press is still held on the next sample and would fire then (the
    // join-throws-a-grenade bug). So: idle for THIS sample, real state into
    // `last` below (no later edge-fires), and every button held at the join
    // goes into suppressedAtJoin, masked until physically released.
    const joinedNow = new Set(result.events.filter((e) => e.type === 'join').map((e) => e.padIndex))
    for (const padIndex of joinedNow) {
      joinTrackers.delete(padIndex)
      const real = states.get(padIndex) ?? idle
      const held = new Set(BOOL_FIELDS.filter((f) => real[f]))
      if (held.size > 0) suppressedAtJoin.set(padIndex, held)
    }

    const inputs = new Map<number, InputCmd>()
    const pauses: number[] = []
    for (const [padIndex, slot] of assignments) {
      const s =
        capturing || joinedNow.has(padIndex) ? idle : maskSuppressed(padIndex, states.get(padIndex) ?? idle)
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
    for (const key of [...last.keys()])
      if (!connected.includes(key)) {
        last.delete(key)
        joinTrackers.delete(key)
        suppressedAtJoin.delete(key)
      }

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
