import { describe, it, expect } from 'vitest'
import {
  initialJoinIntent,
  stepJoinIntent,
  STICK_JOIN_SAMPLES,
  STICK_JOIN_THRESHOLD,
  type JoinIntentState,
} from './padJoin'
import { padProfile } from './padProfile'

const btn = (pressed: boolean) => ({ pressed, touched: pressed, value: pressed ? 1 : 0 })

const fakePad = (over: { buttons?: boolean[]; axes?: number[]; axisCount?: number; mapping?: string } = {}) =>
  ({
    id: 'test',
    mapping: over.mapping ?? 'standard',
    buttons: Array.from({ length: 17 }, (_, i) => btn(over.buttons?.[i] ?? false)),
    axes: Array.from({ length: over.axisCount ?? 10 }, (_, i) => over.axes?.[i] ?? 0),
  }) as unknown as Gamepad

const std = padProfile(fakePad())
const raw = padProfile(fakePad({ mapping: '' })) // 10 axes → genuinely unmapped

/** Run a sequence of pads through the tracker; return whether any step joined
 * and the final state. */
const run = (pads: Gamepad[], profile = std, from?: JoinIntentState) => {
  let state = from ?? initialJoinIntent()
  let joined = false
  for (const p of pads) {
    const r = stepJoinIntent(state, p, profile)
    state = r.state
    joined ||= r.join
  }
  return { joined, state }
}

const stick = (x: number, y = 0) => fakePad({ axes: [x, y] })
const idle = () => fakePad()

describe('stepJoinIntent: any button joins immediately', () => {
  // Every mapped index — face, bumpers, triggers, Back/Start, stick clicks,
  // d-pad. A press is a fact about the pad even on guessed raw layouts.
  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])('button %i joins on the first sample', (i) => {
    const buttons: boolean[] = []
    buttons[i] = true
    expect(stepJoinIntent(initialJoinIntent(), fakePad({ buttons }), std).join).toBe(true)
  })
  it('an analog trigger reported only via value joins too', () => {
    const pad = fakePad()
    ;(pad.buttons as unknown as { pressed: boolean; value: number }[])[7] = { pressed: false, value: 0.9 }
    expect(stepJoinIntent(initialJoinIntent(), pad, std).join).toBe(true)
  })
  it('the unmapped Home button (16) does NOT join — the OS/browser owns it', () => {
    const buttons: boolean[] = []
    buttons[16] = true
    expect(stepJoinIntent(initialJoinIntent(), fakePad({ buttons }), std).join).toBe(false)
  })
})

describe('stepJoinIntent: firm sustained stick deflection joins', () => {
  it('joins after STICK_JOIN_SAMPLES consecutive firm pushes once neutral is proven', () => {
    const seq = [idle(), ...Array.from({ length: STICK_JOIN_SAMPLES }, () => stick(0.9))]
    expect(run(seq).joined).toBe(true)
  })
  it('needs the full sustain: one sample short never joins', () => {
    const seq = [idle(), ...Array.from({ length: STICK_JOIN_SAMPLES - 1 }, () => stick(0.9))]
    expect(run(seq).joined).toBe(false)
  })
  it('a dip below the threshold resets the sustain count', () => {
    const seq = [idle(), stick(0.9), stick(0.9), stick(0.1), stick(0.9), stick(0.9)]
    expect(run(seq).joined).toBe(false)
  })
  it('a push exactly at the threshold does not count (must be beyond)', () => {
    const seq = [idle(), ...Array.from({ length: 10 }, () => stick(STICK_JOIN_THRESHOLD))]
    expect(run(seq).joined).toBe(false)
  })
  it('the right (aim) stick joins on a standard pad', () => {
    const aim = (v: number) => fakePad({ axes: [0, 0, v, 0] })
    const seq = [idle(), ...Array.from({ length: STICK_JOIN_SAMPLES }, () => aim(0.9))]
    expect(run(seq).joined).toBe(true)
  })
  it('judges the pair radially: a diagonal push past the threshold joins', () => {
    const seq = [idle(), ...Array.from({ length: STICK_JOIN_SAMPLES }, () => stick(0.45, 0.45))]
    expect(run(seq).joined).toBe(true) // hypot(.45,.45) ≈ 0.64 > 0.5
  })
})

describe('stepJoinIntent: what must NEVER join', () => {
  it('drift just outside the deadzone (±0.3) never joins, however long it lasts', () => {
    const seq = Array.from({ length: 100 }, () => stick(0.3))
    expect(run(seq).joined).toBe(false)
  })
  it('sub-threshold wiggling never joins', () => {
    const seq = [idle(), stick(0.4), stick(-0.45, 0.1), stick(0.35), stick(-0.4)]
    expect(run(seq).joined).toBe(false)
  })
  it('a pad that appears already deflected never joins until it proves neutral', () => {
    // The resting-trigger shape: an axis pinned at full deflection from the
    // first sample we ever see. Without a visit to neutral it is not a stick.
    const seq = Array.from({ length: 50 }, () => stick(-1))
    expect(run(seq).joined).toBe(false)
  })
  it('...but joins normally after it finally rests then pushes', () => {
    const pre = run(Array.from({ length: 5 }, () => stick(-1)))
    const seq = [idle(), ...Array.from({ length: STICK_JOIN_SAMPLES }, () => stick(-1))]
    expect(run(seq, std, pre.state).joined).toBe(true)
  })
  it('a resting analog trigger pair (-1,-1) on the aim axes of a 4-axis canonical pad never joins', () => {
    const canonical = padProfile(fakePad({ mapping: '', axisCount: 4 }))
    const pads = Array.from({ length: 50 }, () => fakePad({ mapping: '', axisCount: 4, axes: [0, 0, -1, -1] }))
    expect(run(pads, canonical).joined).toBe(false)
  })
  it('raw pads have no trusted aim axes: axes 2/3 pinned at ±1 never join', () => {
    const pads = Array.from({ length: 50 }, () => fakePad({ mapping: '', axes: [0, 0, 1, -1] }))
    expect(run(pads, raw).joined).toBe(false)
  })
  it('the speculative raw hat axis (9) never joins, even at an exact hat value', () => {
    // A resting trigger at -1 on axis 9 decodes as a VALID hat "up" — that is
    // precisely why hat readings are not join intent.
    const axes: number[] = []
    axes[9] = -1
    const pads = Array.from({ length: 50 }, () => fakePad({ mapping: '', axes: [...axes] }))
    expect(run(pads, raw).joined).toBe(false)
  })
  it('NaN / garbage axes never join', () => {
    const pads = Array.from({ length: 50 }, () => fakePad({ axes: [NaN, NaN, NaN, NaN] }))
    expect(run(pads).joined).toBe(false)
  })
  it('a totally idle pad never joins', () => {
    expect(run(Array.from({ length: 100 }, () => idle())).joined).toBe(false)
  })
})

describe('stepJoinIntent: raw pads DO stick-join on their trusted movement axes', () => {
  it('left-stick push joins a raw pad after neutral proof', () => {
    const seq = [
      fakePad({ mapping: '' }),
      ...Array.from({ length: STICK_JOIN_SAMPLES }, () => fakePad({ mapping: '', axes: [0.9, 0] })),
    ]
    expect(run(seq, raw).joined).toBe(true)
  })
})
