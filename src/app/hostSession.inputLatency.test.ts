import { describe, expect, it } from 'vitest'
import { HostSession } from './hostSession'
import { emptyInput, type InputCmd } from '../game/types'
import type { CoopSample } from '../input/gamepadCoop'

/**
 * Single-player input→sim latency (the owner's "stuck walking / sluggish, and
 * pause + roll take a while to register" report). The ACTUAL cause was a sim
 * perf regression (the O(n²) collision door-scan) starving the fixed-step loop
 * so the sim ran behind real time — see movement.test.ts + the door-index fix.
 *
 * These guard the OTHER half the coordinator flagged: that the local input path
 * itself has no latency — a released stick zeroes intent the SAME tick it is
 * sampled (no stale movement vector), and discrete presses (roll, pause) take
 * effect the tick they arrive. HostSession samples localInput once per tick, so
 * driving tick() one at a time is the real production path.
 */

/** One scripted InputCmd per tick, exactly as keyboard/touch/gamepad feed
 * HostSession.tick(). Exhausted → neutral (centred stick, no buttons). */
const scriptInput = (timeline: Partial<InputCmd>[]): { sample: () => InputCmd } => {
  const q = timeline.map((c) => ({ ...emptyInput(), ...c }))
  return { sample: (): InputCmd => q.shift() ?? { ...emptyInput() } }
}

const scriptCoop = (timeline: CoopSample[]): { sample: () => CoopSample } => {
  const q = [...timeline]
  return { sample: (): CoopSample => q.shift() ?? { inputs: new Map(), joins: [], leaves: [], pauses: [] } }
}

describe('single-player input latency: released stick stops the player the same tick', () => {
  it('a held move produces intent, and RELEASING it zeroes intent immediately (no stuck-walk)', () => {
    const s = new HostSession(1, scriptInput([{ moveX: 1 }, { moveX: 1 }, { moveX: 0 }]))
    s.tick()
    expect(s.self.intent.x).toBeCloseTo(1, 6) // walking right
    s.tick()
    expect(s.self.intent.x).toBeCloseTo(1, 6) // still walking
    s.tick() // stick released this tick
    expect(s.self.intent.x).toBe(0) // stopped on the SAME tick — no lingering vector
  })

  it('a neutral stick never self-propels (a fresh player at rest has zero intent)', () => {
    const s = new HostSession(2, scriptInput([{}, {}, {}]))
    for (let i = 0; i < 3; i++) s.tick()
    expect(s.self.intent.x).toBe(0)
    expect(s.self.intent.y).toBe(0)
  })

  it('diagonal release: both axes drop to zero together', () => {
    const s = new HostSession(3, scriptInput([{ moveX: 1, moveY: 1 }, { moveX: 0, moveY: 0 }]))
    s.tick()
    expect(Math.hypot(s.self.intent.x, s.self.intent.y)).toBeGreaterThan(0.5)
    s.tick()
    expect(s.self.intent.x).toBe(0)
    expect(s.self.intent.y).toBe(0)
  })
})

describe('single-player input latency: discrete presses register on arrival', () => {
  it('a roll press starts the roll the tick it is sampled', () => {
    const s = new HostSession(4, scriptInput([{ roll: true }]))
    expect(s.self.playerCtl?.roll).toBeUndefined()
    s.tick()
    expect(s.self.playerCtl?.roll).toBeDefined() // rolled immediately, not a tick late
  })

  it('a pause press toggles pause the tick it is sampled', () => {
    const coop = scriptCoop([{ inputs: new Map(), joins: [], leaves: [], pauses: [0] }])
    const s = new HostSession(5, scriptInput([]), coop)
    expect(s.isPaused).toBe(false)
    s.tick()
    expect(s.isPaused).toBe(true) // paused on the press, not delayed
  })
})
